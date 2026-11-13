import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3000);

// 환경 변수 검증 (미설정 시 기본 오픈 없이 차단)
const G2_READ_KEY = process.env.G2_READ_KEY?.trim();
const G2_WRITE_KEY = process.env.G2_WRITE_KEY?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();
const G2_AUDIO_KEY = process.env.G2_AUDIO_KEY?.trim();
const MAX_AUDIO_BYTES = 16_000 * 2 * 8;

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

// 1. 헤더 인증 미들웨어 (JSON 파싱 전에 즉각 차단)
const authenticate = (requiredRole) => {
  return (req, res, next) => {
    const key = req.headers['x-g2-key'];
    if (!key) {
      return res.status(401).json({ error: '인증 헤더(x-g2-key)가 누락되었습니다.' });
    }

    if (!G2_READ_KEY || !G2_WRITE_KEY) {
      return res.status(503).json({ error: '서버 인증 키가 구성되지 않았습니다.' });
    }
if (requiredRole === 'audio') {
  if (!G2_AUDIO_KEY) {
    return res.status(503).json({ error: '안경 마이크 키가 설정되지 않았습니다.' });
  }
  if (key === G2_AUDIO_KEY) return next();
  return res.status(403).json({ error: '안경 마이크 키를 확인해 주세요.' });
}
    if (requiredRole === 'read') {
      if (key === G2_READ_KEY || key === G2_WRITE_KEY) return next();
    } else if (requiredRole === 'write') {
      if (key === G2_WRITE_KEY) return next();
    }

    return res.status(403).json({ error: '권한이 없는 유효하지 않은 키입니다.' });
  };
};

// 2. 비용 방어선 (검증 통과 후에만 집계되는 Rate Limit)
let isTranslating = false;
let requestTimestamps = [];
let dailyCount = 0;
let lastResetDate = new Date().toDateString();

const checkRateLimit = (req, res, next) => {
  const now = Date.now();
  const today = new Date().toDateString();

  if (today !== lastResetDate) {
    dailyCount = 0;
    lastResetDate = today;
  }

  if (dailyCount >= 200) {
    return res.status(429).json({ error: '일일 최대 번역 한도에 도달했습니다.' });
  }

  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);
  if (requestTimestamps.length >= 15) {
    return res.status(429).json({ error: '요청이 너무 빠릅니다. 잠시 후 다시 시도하세요.' });
  }

  if (isTranslating) {
    return res.status(429).json({ error: '이전 번역 요청이 처리 중입니다.' });
  }

  next();
};

const consumeRateLimit = () => {
  requestTimestamps.push(Date.now());
  dailyCount++;
};

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
  checkRateLimit,
  async (req, res) => {
    // 모든 검증 통과 후 카운터 차감 및 락 획득
    consumeRateLimit();
    isTranslating = true;

    const { targetLang = 'ko' } = req.body ?? {};
    const cleanText = req.cleanText;
    const signal = AbortSignal.timeout(req.fromGlasses ? 15_000 : 8_000); // 8초 타임아웃
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const language = targetLang === 'ko' ? '한국어' : '영어';

    const contents = [
  `당신은 스마트 안경용 통역사입니다. 발화를 ${language}로 자연스럽고 간결하게 번역하세요.`,
  'suggestions에는 상대에게 바로 말할 수 있는 짧은 답변을 다음 순서로 3개 작성하세요.',
  '1번 긍정 또는 수락, 2번 정중한 거절 또는 대안, 3번 상황을 확인하는 역질문.',
  '각 답변은 상대방의 언어로 작성하고, 추천 답변의 한글 발음과 한국어 뜻을 함께 적으세요.',
  '입력 발화가 한국어이고 영어로 번역하는 모드에서는 추천 답변도 영어로 작성하세요.',
  '추천 답변은 각각 한 문장으로 짧게 쓰고, 아래 필드에 맞는 JSON으로 응답하세요.',
  '형식: {"translation":"번역","suggestions":[{"reply":"외국어 답변","pronunciation":"한글 발음","meaning":"한국어 뜻"}]}',
  `발화 원문: ${JSON.stringify(cleanText)}`,
].join('\n');

    try {
      let modelContents = contents;

if (req.fromGlasses) {
  const pcm = req.body;
  const wav = Buffer.alloc(44 + pcm.length);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);       // PCM
  wav.writeUInt16LE(1, 22);       // 모노
  wav.writeUInt32LE(16_000, 24);  // 샘플레이트
  wav.writeUInt32LE(32_000, 28);  // 초당 바이트 수
  wav.writeUInt16LE(2, 32);       // 샘플당 바이트 수
  wav.writeUInt16LE(16, 34);      // 비트 깊이
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  modelContents = [{
    role: 'user',
    parts: [
      {
        text: [
          '녹음에서 명확하게 들리는 발화를 원래 언어 그대로 original에 적으세요.',
          '그 발화를 자연스럽고 간결하게 한국어로 번역해 translation에 적으세요.',
          'suggestions에는 긍정, 정중한 거절 또는 대안, 역질문 순서로 짧은 답변을 3개 작성하세요.',
          '각 답변은 발화와 같은 언어로 reply에 적고, pronunciation에는 한글 발음, meaning에는 한국어 뜻을 적으세요.',
          '명확한 발화가 없으면 original을 빈 문자열로 반환하세요. 들리지 않은 말을 지어내지 마세요.',
        ].join('\n'),
      },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
    ],
  }];
}
const response = await ai.models.generateContent({
  model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
  contents: modelContents,
  config: {
    abortSignal: signal,
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
      const original = req.fromGlasses ? result?.original?.trim() : cleanText;

if (!isText(original)) {
  return res.status(422).json({ error: '음성을 인식하지 못했습니다.' });
}
const suggestions = result?.suggestions;

if (
  !isText(result?.translation) ||
  !Array.isArray(suggestions) ||
  suggestions.length !== 3 ||
  !suggestions.every((item) =>
    isText(item?.reply) &&
    isText(item?.pronunciation) &&
    isText(item?.meaning)
  )
) {
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

latestText = [original, translation, '', replyBlocks.join('\n\n')].join('\n');

return res.status(200).json({
  original,
  translation,
  suggestions,
  text: latestText,
});

    } catch (error) {
      if (signal.aborted) {
        console.error('[Gemini 타임아웃] 응답 대기 시간 초과');
        return res.status(504).json({ error: 'Gemini translation timed out' });
      }
      console.error('[Gemini API 오류]:', error);
      return res.status(500).json({ error: 'Translation failed' });
    } finally {
      isTranslating = false;
    }
  }
);

app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter secure server listening on port ${port}`);
});
