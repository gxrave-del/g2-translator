import express from 'express';
import { GoogleGenAI, Modality } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';

const app = express();
const port = Number(process.env.PORT || 3000);

// 환경 변수 검증 (미설정 시 기본 오픈 없이 차단)
const G2_READ_KEY = process.env.G2_READ_KEY?.trim();
const G2_WRITE_KEY = process.env.G2_WRITE_KEY?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const G2_AUDIO_KEY = process.env.G2_AUDIO_KEY?.trim();
const SAMPLE_RATE = 16_000;
const MAX_AUDIO_SECONDS = 30;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS;
const LIVE_CHUNK_BYTES = SAMPLE_RATE * 2 / 10;
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL?.trim() || 'gemini-3.5-live-translate-preview';
const FINAL_MODEL = 'gemini-3.5-flash-lite';
console.log('[최종 번역 모델]', FINAL_MODEL);

if (!G2_READ_KEY || !G2_WRITE_KEY) {
  console.warn('[경고] G2_READ_KEY 또는 G2_WRITE_KEY가 설정되지 않았습니다.');
}

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-g2-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// G2 안경 렌즈 HUD 표시용 텍스트 상태
let latestText = "Server Online!\nReady for stream";

function authFailure(requiredRole, key) {
  if (typeof key !== 'string' || !key) {
    return [401, '인증 키가 누락되었습니다.'];
  }
  if (!G2_READ_KEY || !G2_WRITE_KEY) {
    return [503, '서버 인증 키가 구성되지 않았습니다.'];
  }

  const allowedKeys = {
    read: [G2_READ_KEY, G2_WRITE_KEY],
    write: [G2_WRITE_KEY],
    audio: [G2_AUDIO_KEY],
  }[requiredRole];
  if (requiredRole === 'audio' && !G2_AUDIO_KEY) {
    return [503, '안경 마이크 키가 설정되지 않았습니다.'];
  }
  if (allowedKeys.includes(key)) return null;
  return [403, requiredRole === 'audio'
    ? '안경 마이크 키를 확인해 주세요.'
    : '권한이 없는 유효하지 않은 키입니다.'];
}

function authenticate(requiredRole) {
  return (req, res, next) => {
    const failure = authFailure(requiredRole, req.headers['x-g2-key']);
    if (!failure) return next();

    const [status, error] = failure;
    return res.status(status).json({ error });
  };
}

function createRateLimit() {
  let timestamps = [];
  let dailyCount = 0;
  let lastResetDate = new Date().toDateString();

  return () => {
    const now = Date.now();
    const today = new Date(now).toDateString();
    if (today !== lastResetDate) {
      dailyCount = 0;
      lastResetDate = today;
    }

    if (dailyCount >= 200) return '일일 최대 번역 한도에 도달했습니다.';
    timestamps = timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (timestamps.length >= 15) return '요청이 너무 빠릅니다. 잠시 후 다시 시도하세요.';

    timestamps.push(now);
    dailyCount++;
    return null;
  };
}

const reserveTranslation = createRateLimit();
const reserveLiveSession = createRateLimit();
let isTranslating = false;

// [공개] 헬스체크
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter', timestamp: new Date().toISOString() });
});

// [공개] 스마트폰 마이크 UI (메모리 보관, localStorage 제거)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>G2 Translator Mic</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121212; color: #fff; text-align: center; padding: 20px; margin: 0; }
    h1 { font-size: 19px; color: #00ff66; margin-bottom: 4px; }
    p { font-size: 12px; color: #888; margin-top: 0; }
    .key-box { margin: 15px auto; max-width: 320px; }
    .key-input { width: 100%; box-sizing: border-box; padding: 10px; font-size: 13px; border-radius: 8px; background: #222; color: #fff; border: 1px solid #444; }
    .mode-select { margin: 15px 0; }
    select { padding: 10px; font-size: 14px; border-radius: 8px; background: #222; color: #fff; border: 1px solid #444; width: 100%; max-width: 320px; }
    .btn-record { width: 100%; max-width: 320px; height: 65px; font-size: 17px; font-weight: bold; border-radius: 33px; border: none; background: #00ff66; color: #000; cursor: pointer; }
    .btn-record.recording { background: #ff334b; color: #fff; }
    .status-box { background: #1c1c1c; border-radius: 10px; padding: 14px; margin: 18px auto; max-width: 320px; min-height: 50px; font-size: 13px; border: 1px solid #333; text-align: left; white-space: pre-wrap; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>G2 HUD Translator</h1>
  <p>스마트폰 음성 입력 ➔ G2 안경 렌즈 투사</p>

  <div class="key-box">
    <input type="password" id="writeKey" class="key-input" placeholder="G2_WRITE_KEY 입력 (창 닫으면 초기화)">
  </div>

  <div class="mode-select">
    <select id="langMode">
      <option value="ko">영어 듣기 ➔ 안경에 한국어로 표시</option>
      <option value="en">한국어 말하기 ➔ 안경에 영어로 표시</option>
    </select>
  </div>

  <button id="recBtn" class="btn-record">🎙️ 터치하고 말하기</button>

  <div class="status-box" id="resultBox">대기 중...</div>

  <script>
    const writeKeyInput = document.getElementById('writeKey');
    const recBtn = document.getElementById('recBtn');
    const resultBox = document.getElementById('resultBox');
    const langMode = document.getElementById('langMode');

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      resultBox.textContent = "현재 브라우저에서 마이크 인식을 지원하지 않습니다. Chrome을 이용해 주세요.";
      recBtn.disabled = true;
    } else {
      const recognizer = new SpeechRecognition();
      recognizer.interimResults = false;
      let isRecording = false;
      let activeLang = 'ko';

      const resetButton = () => {
        isRecording = false;
        recBtn.textContent = "🎙️ 터치하고 말하기";
        recBtn.classList.remove('recording');
      };

      recBtn.onclick = () => {
        const key = writeKeyInput.value.trim();
        if (!key) {
          alert('G2_WRITE_KEY 비밀키를 먼저 입력하세요.');
          return;
        }

        if (!isRecording) {
          activeLang = langMode.value;
          recognizer.lang = activeLang === 'ko' ? 'en-US' : 'ko-KR';
          try {
            recognizer.start();
            isRecording = true;
            recBtn.textContent = "🛑 듣는 중... (터치 시 중지)";
            recBtn.classList.add('recording');
            resultBox.textContent = "음성을 듣고 있습니다...";
          } catch(e) {
            resetButton();
          }
        } else {
          recognizer.stop();
          resetButton();
        }
      };

      recognizer.onend = () => {
        if (isRecording) resetButton();
      };

      recognizer.onresult = async (event) => {
        resetButton();
        const spokenText = event.results[0][0].transcript;
        resultBox.textContent = "인식: " + spokenText + "\\n번역 요청 중...";

        try {
          const res = await fetch('/translate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-g2-key': writeKeyInput.value.trim()
            },
            body: JSON.stringify({ text: spokenText, targetLang: activeLang })
          });
          const data = await res.json();
          if (res.ok && data.translation) {
            resultBox.textContent = "원문: " + spokenText + "\\n안경 전송: " + data.translation;
          } else {
            resultBox.textContent = "요청 실패 (" + res.status + "): 다시 시도해 주세요.";
          }
        } catch (e) {
          resultBox.textContent = "네트워크 연결 실패";
        }
      };

      recognizer.onerror = () => {
        resultBox.textContent = "음성을 인식하지 못했습니다.";
        resetButton();
      };
    }
  </script>
</body>
</html>
  `);
});

// [보안 읽기] G2 안경 렌즈 폴링 창구 (인증 필수)
app.get('/latest-translation', authenticate('read'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).json({ text: latestText });
});

// [보안 쓰기] 직접 텍스트 푸시
app.post('/push-translation', authenticate('write'), express.json({ limit: '10kb' }), (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text === 'string' && text.trim()) {
    latestText = text.trim();
  }
  res.status(200).json({ ok: true, text: latestText });
});

// [보안 번역] 인증 ➔ 파싱 ➔ 입력/설정 검증 ➔ 한도 집계 ➔ Gemini 호출
const parseText = express.json({ limit: '10kb' });
const parseAudio = express.raw({
  type: 'application/octet-stream',
  limit: MAX_AUDIO_BYTES,
  inflate: false,
});

app.post(
  ['/translate', '/translate-audio'],
  (req, res, next) => {
    req.fromGlasses = req.path === '/translate-audio';
    authenticate(req.fromGlasses ? 'audio' : 'write')(req, res, next);
  },
  (req, res, next) => {
    const parse = req.fromGlasses ? parseAudio : parseText;
    parse(req, res, next);
  },
  (req, res, next) => {
    if (req.fromGlasses) {
      if (!Buffer.isBuffer(req.body) ||
          req.body.length < 3_200 ||
          req.body.length % 2 !== 0) {
        return res.status(400).json({ error: '녹음이 너무 짧거나 형식이 올바르지 않습니다.' });
      }
    } else {
      const { text } = req.body ?? {};
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'No text provided' });
      }
      req.cleanText = text.trim();
      if (req.cleanText.length > 150) {
        return res.status(400).json({ error: '발화 길이가 너무 깁니다 (최대 150자 제한)' });
      }
    }

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ error: 'GEMINI_API_KEY가 서버에 구성되지 않았습니다.' });
    }
    next();
  },
  async (req, res) => {
    if (isTranslating) {
      return res.status(429).json({ error: '이전 번역 요청이 처리 중입니다.' });
    }
    const limitError = reserveTranslation();
    if (limitError) return res.status(429).json({ error: limitError });

    isTranslating = true;
    const liveFinal = req.fromGlasses && req.query.mode === 'live';
    const model = liveFinal
      ? FINAL_MODEL
      : process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
    const timeout = liveFinal ? 20_000 : req.fromGlasses ? 15_000 : 8_000;
    const signal = AbortSignal.timeout(timeout);

    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const { targetLang = 'ko' } = req.body ?? {};
      const language = targetLang === 'ko' ? '한국어' : '영어';

      const replyInstructions = [
        '상대에게 바로 말할 수 있는 답변을 세 가지 만드세요.',
        '긍정·수락, 정중한 거절·대안, 상황을 확인하는 역질문 순서로 각각 한 문장씩 적으세요.',
        '답변의 reply에는 상대의 언어로 쓴 문장, pronunciation에는 한글 발음, meaning에는 한국어 뜻을 적으세요.',
        '상대가 말한 장소, 숫자, 부정 표현을 살리세요. 확인되지 않은 사실을 지어내지 마세요.',
      ];
      const contents = req.fromGlasses
        ? [{
            role: 'user',
            parts: [
              {
                text: [
                  '명확하게 들리는 발화를 원래 언어 그대로 original에 적으세요. 문장을 요약하지 마세요.',
                  '원문 전체를 자연스러운 한국어로 번역해 translation에 적으세요.',
                  ...replyInstructions,
                  '명확한 말소리가 없으면 original을 빈 문자열로 반환하세요.',
                ].join('\n'),
              },
              { inlineData: { mimeType: 'audio/wav', data: toWav(req.body).toString('base64') } },
            ],
          }]
        : [
            `발화를 ${language}로 자연스럽고 간결하게 번역해 translation에 적으세요.`,
            ...replyInstructions,
            '한국어를 영어로 번역하는 모드에서는 추천 답변을 영어로 작성하세요.',
            `발화 원문: ${JSON.stringify(req.cleanText)}`,
          ].join('\n');

      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          abortSignal: signal,
          ...(model === 'gemini-4-hydrogen' ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: {
              ...(req.fromGlasses ? { original: { type: 'string' } } : {}),
              translation: { type: 'string' },
              suggestions: {
                type: 'array',
                minItems: 3,
                maxItems: 3,
                items: {
                  type: 'object',
                  properties: {
                    reply: { type: 'string' },
                    pronunciation: { type: 'string' },
                    meaning: { type: 'string' },
                  },
                  required: ['reply', 'pronunciation', 'meaning'],
                },
              },
            },
            required: req.fromGlasses
              ? ['original', 'translation', 'suggestions']
              : ['translation', 'suggestions'],
          },
        },
      });

      const result = JSON.parse(response.text ?? '{}');
      const isText = (value) => typeof value === 'string' && value.trim().length > 0;
      const original = req.fromGlasses ? result?.original : req.cleanText;
      if (!isText(original)) {
        return res.status(422).json({ error: '음성을 인식하지 못했습니다.' });
      }

      const suggestions = result?.suggestions;
      if (!isText(result?.translation) ||
          !Array.isArray(suggestions) ||
          suggestions.length !== 3 ||
          !suggestions.every((item) =>
            isText(item?.reply) && isText(item?.pronunciation) && isText(item?.meaning)
          )) {
        return res.status(502).json({ error: '번역 결과의 형식이 올바르지 않습니다.' });
      }

      const translation = result.translation.trim();
      const labels = ['긍정', '거절·대안', '역질문'];
      const replyBlocks = suggestions.map((item, index) => [
        `${index + 1}. ${labels[index]}`,
        item.reply.trim(),
        item.pronunciation.trim(),
        item.meaning.trim(),
      ].join('\n'));

      latestText = [original.trim(), translation, '', replyBlocks.join('\n\n')].join('\n');
      return res.status(200).json({ original: original.trim(), translation, suggestions, text: latestText });
    } catch (error) {
      if (signal.aborted) {
        console.error('[Gemini 타임아웃]', model);
        return res.status(504).json({ error: '번역 응답이 늦어졌습니다.' });
      }
      console.error('[Gemini 번역 오류]', { model, name: error.name, status: error.status });
      return res.status(500).json({ error: '번역을 마치지 못했습니다.' });
    } finally {
      isTranslating = false;
    }
  },
);

function toWav(pcm) {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter listening on port ${port}`);
});

const liveSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 8_192,
  perMessageDeflate: false,
});
let liveInUse = false;

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/live-translate' || liveSockets.clients.size >= 8) {
    socket.destroy();
    return;
  }
  liveSockets.handleUpgrade(request, socket, head, (client) => {
    liveSockets.emit('connection', client);
  });
});

liveSockets.on('connection', (client) => {
  let phase = 'auth';
  let ownsSlot = false;
  let opening = false;
  let liveSession;
  let pcmBytes = 0;
  let original = '';
  let interim = '';
  let translation = '';
  let captionTimer;
  let deadline = setTimeout(() => end(401, '인증 시간이 초과됐습니다.'), 5_000);

  function end(status, error) {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(deadline);
    clearTimeout(captionTimer);
    if (ownsSlot && !opening) liveInUse = false;
    liveSession?.close();

    if (client.readyState === WebSocket.OPEN) {
      if (error) client.send(JSON.stringify({ type: 'error', status, error }));
      client.close();
    }
  }

  function sendCaption() {
    captionTimer = undefined;
    if (phase !== 'captions' || client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify({
      type: 'caption',
      original: (original + interim).trim().slice(-2_000),
      translation: translation.trim().slice(-2_000),
    }));
  }

  function onLiveMessage({ serverContent }) {
    if (phase !== 'captions' || !serverContent) return;
    const input = serverContent.inputTranscription;
    const preview = serverContent.interimInputTranscription;
    const output = serverContent.outputTranscription;
    if (input) {
      original = (original + (input.text ?? '') + (input.finished ? ' ' : '')).slice(-2_000);
      interim = '';
    }
    if (typeof preview?.text === 'string') interim = preview.text;
    if (output) {
      translation = (translation + (output.text ?? '') + (output.finished ? ' ' : '')).slice(-2_000);
    }
    if ((input || preview || output) && !captionTimer) {
      captionTimer = setTimeout(sendCaption, 250);
    }
  }

  async function connectLive() {
    opening = true;
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } });
      const session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: { targetLanguageCode: 'ko', echoTargetLanguage: true },
        },
        callbacks: {
          onmessage: onLiveMessage,
          onerror: () => end(502, '실시간 번역 연결 오류'),
          onclose: ({ code }) => {
            if (phase === 'closed') return;
            console.warn('[Gemini Live 연결 종료]', code);
            end(502, '실시간 번역 연결이 끊겼습니다.');
          },
        },
      });
      if (phase === 'closed') {
        session.close();
        return;
      }

      liveSession = session;
      phase = 'captions';
      clearTimeout(deadline);
      deadline = setTimeout(() => end(408, '실시간 자막 시간이 끝났습니다.'), 35_000);
      client.send(JSON.stringify({ type: 'ready' }));
    } catch (error) {
      if (phase === 'closed') return;
      console.error('[Gemini Live 연결 오류]', { model: LIVE_MODEL, name: error.name, status: error.status });
      end(502, '실시간 번역에 연결하지 못했습니다.');
    } finally {
      opening = false;
      if (phase === 'closed') liveInUse = false;
    }
  }

  client.on('message', (data, isBinary) => {
    if (phase === 'closed') return;
    if (phase === 'auth') {
      let auth;
      if (!isBinary) {
        try { auth = JSON.parse(data.toString()); } catch { /* 인증 실패로 처리 */ }
      }
      const failure = authFailure('audio', auth?.type === 'start' ? auth.key : undefined);
      if (failure) return end(...failure);
      if (!GEMINI_API_KEY) return end(503, 'Gemini API 키가 설정되지 않았습니다.');
      if (liveInUse) return end(429, '다른 실시간 자막이 진행 중입니다.');
      const limitError = reserveLiveSession();
      if (limitError) return end(429, limitError);

      ownsSlot = true;
      liveInUse = true;
      phase = 'connecting';
      clearTimeout(deadline);
      deadline = setTimeout(() => end(504, '실시간 자막 연결이 늦어졌습니다.'), 6_000);
      void connectLive();
      return;
    }

    if (phase !== 'captions' || !isBinary || data.length === 0 ||
        data.length > LIVE_CHUNK_BYTES || data.length % 2 !== 0) {
      return end(400, '음성 데이터 형식이 올바르지 않습니다.');
    }

    pcmBytes += data.length;
    if (pcmBytes > MAX_AUDIO_BYTES) return end(413, '30초 녹음 한도를 초과했습니다.');

    try {
      liveSession.sendRealtimeInput({
        audio: { data: data.toString('base64'), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` },
      });
    } catch {
      end(502, '실시간 음성을 전송하지 못했습니다.');
    }
  });
  client.on('close', () => end());
  client.on('error', () => end());
});
