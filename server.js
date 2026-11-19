import { setTimeout as delay } from 'node:timers/promises';
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
const MAX_AUDIO_SECONDS = 60;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS;
const LIVE_CHUNK_BYTES = SAMPLE_RATE * 2 / 10;
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL?.trim() || 'gemini-3.5-live-translate-preview';
const FINAL_MODEL_OPTIONS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const configuredFinalModel = process.env.GEMINI_FINAL_MODEL?.trim();
const FINAL_MODEL = FINAL_MODEL_OPTIONS.includes(configuredFinalModel)
  ? configuredFinalModel : FINAL_MODEL_OPTIONS[0];
const FINAL_BACKUP_MODEL = FINAL_MODEL_OPTIONS.find((model) => model !== FINAL_MODEL);
const AUDIO_FINAL_MODEL = FINAL_MODEL_OPTIONS[0];
// 비교 중에는 선택 모델로 고정합니다. 명시적으로 true를 설정한 경우에만 자동 전환합니다.
const ALLOW_FINAL_FALLBACK = process.env.G2_FINAL_FALLBACK?.trim().toLowerCase() === 'true';
if (configuredFinalModel && configuredFinalModel !== FINAL_MODEL) {
  console.warn('[최종 모델 설정 확인]', 'GEMINI_FINAL_MODEL은 3.5 또는 3.1 Flash-Lite만 지원합니다. 기본 모델을 사용합니다.');
}
// 위트 유무를 같은 모델에서 비교할 때만 3으로 설정합니다. 기본값은 기존 4개입니다.
const REPLY_COUNT = process.env.G2_REPLY_COUNT?.trim() === '3' ? 3 : 4;
const FINAL_CACHE_TTL_MS = 5 * 60_000;
const FINAL_CACHE_MAX_ITEMS = 64;
const finalCache = new Map();
const modelBusyUntil = new Map();
let finalAI;

async function timedGeminiFetch(input, init) {
  const startedAt = performance.now();
  const requestUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  // URL·헤더·요청 본문을 기록하지 않고 모델명만 추출합니다.
  const model = requestUrl?.match(/\/models\/([A-Za-z0-9._-]+)/)?.[1] || 'unknown';
  try {
    const response = await fetch(input, init);
    console.info('[Gemini HTTP 수신]', {
      model, status: response.status,
      headersMs: Math.round(performance.now() - startedAt),
      contentType: response.headers.get('content-type'),
    });
    return response;
  } catch (error) {
    console.warn('[Gemini HTTP 수신 실패]', {
      model, headersMs: Math.round(performance.now() - startedAt),
      name: error.name, aborted: init?.signal?.aborted === true,
    });
    throw error;
  }
}

function getFinalAI() {
  // SDK 내부 재시도는 끄고, 아래의 최대 2회 호출 한도로 관리합니다.
  return finalAI ??= new GoogleGenAI({
    apiKey: GEMINI_API_KEY,
    httpOptions: { retryOptions: { attempts: 1 }, fetch: timedGeminiFetch },
  });
}

function finalCacheKey(original, translation) {
  if (!original || original.length > 300) return null;
  return JSON.stringify([original, translation]);
}

function getFinalCache(original, translation) {
  const key = finalCacheKey(original, translation);
  const entry = key && finalCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt >= FINAL_CACHE_TTL_MS) {
    finalCache.delete(key);
    return null;
  }
  finalCache.delete(key);
  finalCache.set(key, entry);
  return { result: structuredClone(entry.result), model: entry.model, cacheHit: true };
}

function setFinalCache(original, translation, output) {
  const key = finalCacheKey(original, translation);
  if (!key || (translation && translation !== output.result.translation)) return;
  for (const [oldKey, entry] of finalCache) {
    if (Date.now() - entry.savedAt >= FINAL_CACHE_TTL_MS) finalCache.delete(oldKey);
  }
  finalCache.delete(key);
  finalCache.set(key, { savedAt: Date.now(), model: output.model, result: structuredClone(output.result) });
  while (finalCache.size > FINAL_CACHE_MAX_ITEMS) finalCache.delete(finalCache.keys().next().value);
}

function availableFinalModels(preferredModel) {
  if (!ALLOW_FINAL_FALLBACK) return [preferredModel];
  const models = [preferredModel, ...FINAL_MODEL_OPTIONS.filter((model) => model !== preferredModel)];
  const available = models.filter((model) => (modelBusyUntil.get(model) || 0) <= Date.now());
  // 두 모델 모두 혼잡했으면 이번 요청에서는 더 오래 전에 실패한 모델만 확인합니다.
  return available.length ? available : [models.sort((a, b) => modelBusyUntil.get(a) - modelBusyUntil.get(b))[0]];
}

const REPLY_LABELS = ['긍정', '거절·대안', '역질문', '위트'].slice(0, REPLY_COUNT);
const REPLY_INSTRUCTIONS = [
  `상대에게 바로 말할 수 있는 답변을 ${REPLY_COUNT}개 만드세요.`,
  REPLY_COUNT === 4
    ? '1번 긍정·수락, 2번 정중한 거절·대안, 3번 상황을 확인하는 역질문, 4번 가볍고 재치 있는 위트 순서입니다.'
    : '1번 긍정·수락, 2번 정중한 거절·대안, 3번 상황을 확인하는 역질문 순서입니다.',
  'reply는 상대의 언어로 짧은 한 문장, pronunciation은 한글 발음, meaning은 한국어 뜻입니다.',
  REPLY_COUNT === 4
    ? '답변은 가능하면 8단어 안팎으로 쓰고, 발음과 뜻은 그 문장에 해당하는 내용만 적으세요. 위트도 짧게 쓰세요.'
    : '답변은 가능하면 8단어 안팎으로 쓰고, 발음과 뜻은 그 문장에 해당하는 내용만 적으세요.',
  '숫자, 장소, 부정 표현을 보존하고 사실을 지어내지 마세요.',
];

function makeFinalResult(result, original = result?.original) {
  const isText = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!isText(original)) {
    throw Object.assign(new Error('음성을 인식하지 못했습니다.'), { status: 422 });
  }
  if (!isText(result?.translation) || !Array.isArray(result.suggestions) ||
      result.suggestions.length !== REPLY_LABELS.length ||
      !result.suggestions.every((item) =>
        isText(item?.reply) && isText(item?.pronunciation) && isText(item?.meaning))) {
    throw Object.assign(new Error('번역 결과의 형식이 올바르지 않습니다.'), { status: 502 });
  }
  const translation = result.translation.trim();
  const replyBlocks = result.suggestions.map((item, index) => [
    `${index + 1}. ${REPLY_LABELS[index]}`,
    item.reply.trim(), item.pronunciation.trim(), item.meaning.trim(),
  ].join('\n'));
  return {
    original: original.trim(), translation, suggestions: result.suggestions,
    text: [original.trim(), translation, '', replyBlocks.join('\n\n')].join('\n'),
  };
}

// 닫힌 JSON 문자열만 읽어서 추천 답변보다 먼저 완성된 번역을 보냅니다.
function readTranslationPrefix(text, original) {
  const match = original
    ? text.match(/^\s*\{\s*"translation"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/)
    : text.match(/^\s*\{\s*"original"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"translation"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/);
  if (!match) return null;
  const source = original || JSON.parse(match[1]);
  const translation = JSON.parse(match[original ? 1 : 2]);
  if (!source.trim() || !translation.trim()) return null;
  return { original: source.trim(), translation: translation.trim() };
}

async function beforeAbort(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    throw signal.reason;
  }
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function streamFinalTranslation(pcm, original, translation, signal, sendTranslation, takeAttempt) {
  const cached = getFinalCache(original, translation);
  if (cached) {
    if (!translation) sendTranslation({ original, translation: cached.result.translation }, cached.model);
    console.info('[답변 재사용]', { model: cached.model, transcriptChars: original.length });
    return cached;
  }
  const instructions = [
    translation
      ? '아래 발화 원문과 한국어 번역을 바탕으로 suggestions만 작성하세요.'
      : original
      ? '발화 원문 전체를 생략하지 말고 자연스러운 한국어로 번역해 translation에 적으세요.'
      : '음성 전체를 원래 언어 그대로 original에 적고, 자연스러운 한국어 번역을 translation에 적으세요. 말소리가 없으면 original은 빈 문자열입니다.',
    ...REPLY_INSTRUCTIONS,
    original ? `발화 원문: ${JSON.stringify(original)}` : '',
    translation ? `한국어 번역: ${JSON.stringify(translation)}` : '',
  ].filter(Boolean).join('\n');
  const contents = original ? instructions : [{ role: 'user', parts: [
    { text: instructions },
    { inlineData: { mimeType: 'audio/wav', data: toWav(pcm).toString('base64') } },
  ] }];
  const schema = {
    type: 'object',
    properties: {
      ...(original ? {} : { original: { type: 'string' } }),
      ...(translation ? {} : { translation: { type: 'string' } }),
      suggestions: {
        type: 'array', minItems: REPLY_COUNT, maxItems: REPLY_COUNT,
        items: {
          type: 'object',
          properties: {
            reply: { type: 'string' }, pronunciation: { type: 'string' }, meaning: { type: 'string' },
          },
          required: ['reply', 'pronunciation', 'meaning'],
        },
      },
    },
    required: translation ? ['suggestions'] : original ? ['translation', 'suggestions'] : ['original', 'translation', 'suggestions'],
    propertyOrdering: translation ? ['suggestions'] : original ? ['translation', 'suggestions'] : ['original', 'translation', 'suggestions'],
  };
  const ai = getFinalAI();
  let sentTranslation = false;
  const preferredModel = original ? FINAL_MODEL : AUDIO_FINAL_MODEL;
  const models = availableFinalModels(preferredModel);
  let model = models[0];
  if (model !== preferredModel) console.info('[혼잡 모델 임시 우회]', { model });
  async function generate() {
    takeAttempt();
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const startedAt = performance.now();
    let firstTokenMs = null;
    let firstChunkChars = 0;
    let thoughtsTokenCount = null;
    let iterator;
    let text = '';
    let completed = false;
    try {
      console.info('[답변 요청 시작]', { model, replyCount: REPLY_COUNT, source: original ? 'text' : 'audio' });
      iterator = await beforeAbort(ai.models.generateContentStream({
        model, contents,
        config: {
          abortSignal: requestSignal,
          automaticContinuation: false,
          thinkingConfig: { thinkingLevel: 'MINIMAL' },
          responseMimeType: 'application/json', responseJsonSchema: schema,
          maxOutputTokens: translation ? 2048 : original ? 3072 : 4096,
        },
      }), requestSignal);
      while (true) {
        const next = await beforeAbort(iterator.next(), requestSignal);
        if (next.done) break;
        const delta = next.value.text || '';
        if (delta && firstTokenMs === null) {
          firstTokenMs = Math.round(performance.now() - startedAt);
          firstChunkChars = delta.length;
          console.info('[답변 첫 응답]', { model, firstTokenMs, firstChunkChars });
        }
        if (Number.isFinite(next.value.usageMetadata?.thoughtsTokenCount)) {
          thoughtsTokenCount = next.value.usageMetadata.thoughtsTokenCount;
        }
        text += delta;
        if (text.length > 64_000) throw Object.assign(new Error('번역 결과가 너무 깁니다.'), { status: 502 });
        if (!sentTranslation && !translation) {
          const prefix = readTranslationPrefix(text, original);
          if (prefix) {
            sentTranslation = true;
            sendTranslation(prefix, model);
          }
        }
        const finishReason = next.value.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') {
          throw Object.assign(new Error('추천 답변 생성을 완료하지 못했습니다.'), { status: 502 });
        }
        // 완성된 JSON은 스트림의 추가 종료 신호를 기다리지 않고 검증해 전달합니다.
        if (text.trimEnd().endsWith('}')) {
          let parsed;
          try { parsed = JSON.parse(text); } catch { /* 다음 조각을 기다립니다. */ }
          if (parsed && typeof parsed === 'object') {
            if (translation) parsed.translation = translation;
            const result = makeFinalResult(parsed, original || undefined);
            completed = true;
            modelBusyUntil.delete(model);
            return result;
          }
        }
      }
      throw Object.assign(new Error('추천 답변 결과가 완성되지 않았습니다.'), { status: 502 });
    } finally {
      console.info('[답변 생성 시간]', {
        model, replyCount: REPLY_COUNT, firstTokenMs, firstChunkChars,
        durationMs: Math.round(performance.now() - startedAt),
        outputChars: text.length, thoughtsTokenCount, completed,
      });
      controller.abort();
      try { iterator?.return?.().catch(() => {}); } catch { /* 이미 종료된 스트림 */ }
    }
  }
  try {
    return { result: await generate(), model };
  } catch (error) {
    error.model = model;
    if (error.status === 503) modelBusyUntil.set(model, Date.now() + 30_000);
    if (error.status !== 503 || sentTranslation || signal.aborted || models.length < 2) throw error;
    await delay(100, undefined, { signal });
    console.warn('[최종 번역 모델 전환]', { from: model, to: models[1], status: 503 });
    model = models[1];
    try {
      return { result: await generate(), model };
    } catch (backupError) {
      backupError.model = model;
      if (backupError.status === 503) modelBusyUntil.set(model, Date.now() + 30_000);
      throw backupError;
    }
  }
}

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

async function generateBeforeDeadline(ai, request, signal) {
  signal.throwIfAborted();

  // SDK 응답과 별도로 요청 처리의 마감 시간도 지킵니다.
  let onAbort;
  const deadline = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([ai.models.generateContent(request), deadline]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

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
    let model = liveFinal
      ? AUDIO_FINAL_MODEL
      : process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
    const timeout = liveFinal ? 20_000 : req.fromGlasses ? 15_000 : 8_000;
    const disconnectController = new AbortController();
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), disconnectController.signal]);
    const onDisconnect = () => {
      if (!res.writableEnded) disconnectController.abort();
    };
    res.once('close', onDisconnect);
    const startedAt = performance.now();

    if (liveFinal) {
      res.once('finish', () => {
        console.info('[최종 번역 응답]', {
          model,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
    }

    try {
      const ai = getFinalAI();
      const { targetLang = 'ko' } = req.body ?? {};
      const language = targetLang === 'ko' ? '한국어' : '영어';

      const replyInstructions = REPLY_INSTRUCTIONS;
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

      const translate = () => generateBeforeDeadline(ai, {
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
                minItems: REPLY_LABELS.length,
                maxItems: REPLY_LABELS.length,
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
      }, signal);

      let response;
      try {
        response = await translate();
      } catch (error) {
        if (!liveFinal || !ALLOW_FINAL_FALLBACK || error.status !== 503 || signal.aborted) throw error;

        // 한 번만 전환하고, 두 모델에 같은 마감 시간과 호출 한도를 적용합니다.
        await delay(100, undefined, { signal });
        const backupLimitError = reserveTranslation();
        if (backupLimitError) return res.status(429).json({ error: backupLimitError });

        const backupModel = FINAL_MODEL_OPTIONS.find((candidate) => candidate !== model);
        console.warn('[최종 번역 모델 전환]', { from: model, to: backupModel, status: 503 });
        model = backupModel;
        response = await translate();
      }

      const result = JSON.parse(response.text ?? '{}');
      const isText = (value) => typeof value === 'string' && value.trim().length > 0;
      const original = req.fromGlasses ? result?.original : req.cleanText;
      if (!isText(original)) {
        return res.status(422).json({ error: '음성을 인식하지 못했습니다.' });
      }

      const suggestions = result?.suggestions;
      if (!isText(result?.translation) ||
          !Array.isArray(suggestions) ||
          suggestions.length !== REPLY_LABELS.length ||
          !suggestions.every((item) =>
            isText(item?.reply) && isText(item?.pronunciation) && isText(item?.meaning)
          )) {
        return res.status(502).json({ error: '번역 결과의 형식이 올바르지 않습니다.' });
      }

      const translation = result.translation.trim();
      const replyBlocks = suggestions.map((item, index) => [
        `${index + 1}. ${REPLY_LABELS[index]}`,
        item.reply.trim(),
        item.pronunciation.trim(),
        item.meaning.trim(),
      ].join('\n'));

      if (signal.aborted || res.destroyed) return;
      latestText = [original.trim(), translation, '', replyBlocks.join('\n\n')].join('\n');
      return res.status(200).json({ original: original.trim(), translation, suggestions, text: latestText });
    } catch (error) {
      if (res.destroyed) return;
      if (signal.aborted) {
        console.error('[Gemini 타임아웃]', model);
        return res.status(504).json({ error: '번역 응답이 늦어졌습니다.' });
      }
      console.error('[Gemini 번역 오류]', { model, name: error.name, status: error.status });
      if (liveFinal && error.status === 503) {
        return res.status(503).json({ error: '번역 서비스가 잠시 혼잡합니다.' });
      }
      return res.status(500).json({ error: '번역을 마치지 못했습니다.' });
    } finally {
      res.off('close', onDisconnect);
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
  console.info('[최종 번역 모델]', FINAL_MODEL,
    ...(ALLOW_FINAL_FALLBACK ? ['예비 모델', FINAL_BACKUP_MODEL] : ['(고정)']));
  console.info('[음성 재처리 모델]', AUDIO_FINAL_MODEL);
  console.info('[모델 자동 전환]', ALLOW_FINAL_FALLBACK ? '켜짐' : '꺼짐 (선택 모델 고정)');
  console.info('[빠른 번역]', `Gemini 전용 v8 · 다음 듣기 전환 지원 · 60초 · 답변 ${REPLY_COUNT}개`);
});

const liveSockets = new WebSocketServer({
  noServer: true,
  maxPayload: 8_192,
  perMessageDeflate: false,
});
let liveInUse = false;
let currentLiveOwner;

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
  let protocol = 1;
  let audioParts = [];
  let transcriptOverflow = false;
  let translationOverflow = false;
  let inputFinished = false;
  let inputConfirmedBytes = 0;
  let outputFinished = false;
  let outputConfirmedBytes = 0;
  let lastInputAt = -Infinity;
  let lastOutputAt = -Infinity;
  let liveFailed = false;
  let clientCancelled = false;
  let finalCaptionTimer;
  let publishFinalCaption;
  let drainCheckTimer;
  let finishStartedAt;
  let finalController;
  let deadline = setTimeout(() => end(401, '인증 시간이 초과됐습니다.'), 5_000);
  const owner = {
    cancelForNext() {
      if (protocol !== 3 || !['captions', 'draining', 'finalizing'].includes(phase)) return false;
      clientCancelled = true;
      end();
      return true;
    },
  };

  function end(status, error) {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(deadline);
    clearTimeout(captionTimer);
    clearTimeout(drainCheckTimer);
    clearTimeout(finalCaptionTimer);
    audioParts = [];
    finalController?.abort();
    if (ownsSlot && !opening) liveInUse = false;
    if (currentLiveOwner === owner) currentLiveOwner = undefined;
    liveSession?.close();

    if (client.readyState === WebSocket.OPEN) {
      if (error) client.send(JSON.stringify({ type: 'error', status, error }));
      client.close();
    }
  }

  function sendCaption() {
    captionTimer = undefined;
    if (!['captions', 'draining'].includes(phase) || client.readyState !== WebSocket.OPEN) return;
    client.send(JSON.stringify({
      type: 'caption',
      original: (original + interim).trim().slice(-2_000),
      translation: translation.trim().slice(-2_000),
    }));
  }

  function onLiveMessage({ serverContent }) {
    if (!['captions', 'draining', 'finalizing'].includes(phase) || !serverContent) return;
    const input = serverContent.inputTranscription;
    const preview = serverContent.interimInputTranscription;
    const output = serverContent.outputTranscription;
    if (input) {
      if (input.text) lastInputAt = performance.now();
      original += (input.text ?? '') + (input.finished ? ' ' : '');
      if (original.length > 12_000) {
        transcriptOverflow = true;
        original = original.slice(-12_000);
      }
      interim = '';
      if (input.text || typeof input.finished === 'boolean') {
        inputFinished = input.finished === true;
      }
      if (input.finished === true) inputConfirmedBytes = pcmBytes;
    }
    if (typeof preview?.text === 'string') {
      interim = preview.text;
      lastInputAt = performance.now();
      if (interim.trim()) inputFinished = false;
    }
    if (output) {
      if (output.text) lastOutputAt = performance.now();
      translation += (output.text ?? '') + (output.finished ? ' ' : '');
      if (translation.length > 12_000) {
        translationOverflow = true;
        translation = translation.slice(-12_000);
      }
      if (output.text || typeof output.finished === 'boolean') {
        outputFinished = output.finished === true;
      }
      if (output.finished === true) outputConfirmedBytes = pcmBytes;
    }
    if (phase !== 'finalizing' && (input || preview || output) && !captionTimer) {
      captionTimer = setTimeout(sendCaption, 250);
    }
    if (phase === 'draining' && (input || preview || output)) scheduleFinalCheck();
    if (protocol === 3 && phase === 'finalizing' && (input || preview || output)) {
      clearTimeout(finalCaptionTimer);
      finalCaptionTimer = setTimeout(() => {
        if (phase !== 'finalizing') return;
        const latest = readStableSource();
        if (latest.original && latest.translation) publishFinalCaption?.(latest);
      }, 410);
    }
  }

  function hasUsableOriginal() {
    return !liveFailed && !interim.trim() && !transcriptOverflow && original.trim().length > 0;
  }

  function readStableSource() {
    const now = performance.now();
    if (!hasUsableOriginal() || now - lastInputAt < 400) {
      return { original: '', translation: '' };
    }
    const reusableTranslation = !translationOverflow && lastOutputAt >= lastInputAt && now - lastOutputAt >= 400;
    return {
      original: original.trim(),
      translation: reusableTranslation ? translation.trim() : '',
    };
  }

  function scheduleFinalCheck() {
    clearTimeout(drainCheckTimer);
    if (phase !== 'draining' || !hasUsableOriginal()) return;
    // 연속 번역에는 finished 필드가 생략될 수 있습니다. 종료 뒤 텍스트 안정 시간을 확인합니다.
    const now = performance.now();
    const quietWait = Math.max(0, 400 - (now - lastInputAt), 400 - (now - lastOutputAt),
      (protocol === 3 ? 1_400 : 1_000) - (now - finishStartedAt));
    drainCheckTimer = setTimeout(() => void finishTranslation(), Math.ceil(quietWait) + 5);
  }

  async function finishTranslation(force = false) {
    if (phase !== 'draining') return;
    let snapshot = readStableSource();
    // 타이머가 수 ms 일찍 실행돼도 확보된 원문을 버리고 음성을 재처리하지 않습니다.
    if (!force && hasUsableOriginal() && !snapshot.original) {
      scheduleFinalCheck();
      return;
    }
    const pcm = Buffer.concat(audioParts, pcmBytes);
    audioParts = [];
    phase = 'finalizing';
    clearTimeout(deadline);
    clearTimeout(captionTimer);
    clearTimeout(drainCheckTimer);
    if (isTranslating) return end(429, '이전 번역 요청이 처리 중입니다.');
    isTranslating = true;
    finalController = new AbortController();
    let source = snapshot.translation ? 'live' : snapshot.original ? 'text' : 'audio';
    // 이미 번역을 받은 새 앱은 추천 답변 때문에 20초를 기다리지 않습니다.
    const finalWaitMs = protocol === 3 && source === 'live' ? 5_000 : 20_000;
    deadline = setTimeout(() => finalController.abort(), finalWaitMs);
    console.info('[최종 번역 시작]', {
      source, audioSeconds: pcmBytes / (SAMPLE_RATE * 2),
      transcriptChars: original.trim().length,
      inputFinished, audioAfterInputEndBytes: pcmBytes - inputConfirmedBytes,
      outputFinished, audioAfterOutputEndBytes: pcmBytes - outputConfirmedBytes,
      interimChars: interim.trim().length,
      translationChars: translation.trim().length,
      transcriptAgeMs: Number.isFinite(lastInputAt) ? Math.round(performance.now() - lastInputAt) : null,
      transcriptOverflow, translationOverflow,
    });
    let status = 200;
    let model = FINAL_MODEL;
    let attempts = 0;
    let cacheHit = false;
    let confirmedTranslation;
    const takeAttempt = () => {
      if (attempts >= 2) {
        throw Object.assign(new Error('마지막 발화가 계속 갱신되고 있습니다.'), { status: 409 });
      }
      const error = reserveTranslation();
      if (error) throw Object.assign(new Error(error), { status: 429 });
      attempts++;
    };
    client.send(JSON.stringify({ type: 'finalizing', source }));
    const sendTranslation = (partial, usedModel) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (source !== 'audio' && (liveFailed || interim.trim() || snapshot.original !== original.trim())) return;
      model = usedModel;
      if (protocol === 3) confirmedTranslation = partial;
      client.send(JSON.stringify({ type: 'translation', ...partial, confirmed: protocol === 3 }));
      console.info('[번역 우선 표시]', {
        model: source === 'live' ? LIVE_MODEL : usedModel,
        source, durationMs: Math.round(performance.now() - finishStartedAt),
      });
    };
    publishFinalCaption = (partial) => {
      if (client.readyState !== WebSocket.OPEN || phase !== 'finalizing') return;
      if (confirmedTranslation?.original === partial.original &&
          confirmedTranslation?.translation === partial.translation) return;
      confirmedTranslation = partial;
      client.send(JSON.stringify({ type: 'translation', ...partial, confirmed: true }));
      console.info('[늦게 도착한 자막 반영]', { model: LIVE_MODEL,
        durationMs: Math.round(performance.now() - finishStartedAt) });
    };
    const generate = () => streamFinalTranslation(
      pcm, snapshot.original, snapshot.translation, finalController.signal, sendTranslation, takeAttempt,
    );
    try {
      if (snapshot.translation) {
        sendTranslation(snapshot, model);
      }
      let output = await generate();
      model = output.model;
      cacheHit = output.cacheHit === true;
      if (phase === 'closed') return;

      // 즉시 끝난 결과나 재사용 결과도 말끝 수신을 잠시 더 확인합니다.
      const tailWait = 1_400 - (performance.now() - finishStartedAt);
      if (tailWait > 0) await delay(tailWait, undefined, { signal: finalController.signal });

      // 생성 중에도 Live 입력을 받아 뒤늦게 온 말끝을 버리지 않습니다.
      if (snapshot.original && (liveFailed || interim.trim() || snapshot.original !== original.trim())) {
        if (attempts >= 2) {
          throw Object.assign(new Error('마지막 발화가 계속 갱신되고 있습니다.'), { status: 409 });
        }
        await delay(400, undefined, { signal: finalController.signal });
        snapshot = readStableSource();
        source = snapshot.translation ? 'live' : snapshot.original ? 'text' : 'audio';
        console.info('[마지막 발화 반영]', { source, transcriptChars: snapshot.original.length });
        if (snapshot.translation) sendTranslation(snapshot, model);
        output = await generate();
        model = output.model;
        cacheHit = output.cacheHit === true;
        if (phase === 'closed') return;
        if (snapshot.original && (liveFailed || interim.trim() || snapshot.original !== original.trim())) {
          throw Object.assign(new Error('마지막 발화가 계속 갱신되고 있습니다.'), { status: 409 });
        }
      }
      if (snapshot.translation) {
        const latest = readStableSource();
        if (latest.original === snapshot.original && latest.translation && latest.translation !== output.result.translation) {
          output.result = makeFinalResult({ ...output.result, translation: latest.translation }, latest.original);
          sendTranslation(latest, model);
        }
      }
      setFinalCache(snapshot.original, snapshot.translation, output);
      latestText = output.result.text;
      client.send(JSON.stringify({ type: 'result', ...output.result }));
    } catch (error) {
      model = error.model || model;
      if (protocol === 3 && !clientCancelled && !finalController.signal.aborted) {
        const remaining = 2_420 - (performance.now() - finishStartedAt);
        if (remaining > 0) {
          try { await delay(remaining, undefined, { signal: finalController.signal }); } catch { /* 다음 듣기 취소 */ }
        }
        if (phase === 'finalizing') {
          const latest = readStableSource();
          if (latest.original && latest.translation) publishFinalCaption?.(latest);
        }
      }
      status = clientCancelled ? 499 : finalController.signal.aborted ? 504 : error.status || 500;
      if (clientCancelled) console.info('[다음 듣기로 전환]', { model, source, status });
      else console.error('[최종 번역 오류]', { model, source, status });
      const errorMessage = {
        409: '마지막 발화 수신이 지연됐습니다. 문장을 다시 말해 주세요.',
        422: '음성을 인식하지 못했습니다.',
        429: '번역 요청 한도에 도달했습니다.',
        503: '번역 서비스가 잠시 혼잡합니다.',
        504: '추천 답변 처리가 지연됐습니다.',
      }[status] || '최종 결과를 완성하지 못했습니다.';
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'error', status,
          stage: protocol === 3 && confirmedTranslation ? 'suggestions' : 'translation',
          error: protocol === 3 && confirmedTranslation
            ? '추천 답변을 받지 못했습니다. 번역은 유지됩니다.' : errorMessage,
        }));
      }
    } finally {
      isTranslating = false;
      console.info('[최종 번역 응답]', {
        model, source, status, attempts, cacheHit,
        durationMs: Math.round(performance.now() - finishStartedAt),
      });
      end();
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
          onerror: () => {
            if (phase === 'closed') return;
            liveFailed = true;
            if (phase === 'finalizing') return;
            if (phase === 'draining') {
              inputFinished = false;
              void finishTranslation();
            } else end(502, '실시간 번역 연결 오류');
          },
          onclose: ({ code }) => {
            if (phase === 'closed') return;
            liveFailed = true;
            if (phase === 'finalizing') return;
            if (phase === 'draining') {
              inputFinished = false;
              void finishTranslation();
              return;
            }
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
      deadline = setTimeout(
        () => end(408, '실시간 자막 시간이 끝났습니다.'),
        (MAX_AUDIO_SECONDS + 5) * 1_000,
      );
      client.send(JSON.stringify({ type: 'ready', protocol }));
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
      if (auth.protocol === 3 && liveInUse) currentLiveOwner?.cancelForNext();
      if (liveInUse) return end(429, '다른 실시간 자막이 진행 중입니다.');
      const limitError = reserveLiveSession();
      if (limitError) return end(429, limitError);

      protocol = auth.protocol === 3 ? 3 : auth.protocol === 2 ? 2 : 1;

      ownsSlot = true;
      liveInUse = true;
      currentLiveOwner = owner;
      phase = 'connecting';
      clearTimeout(deadline);
      deadline = setTimeout(() => end(504, '실시간 자막 연결이 늦어졌습니다.'), 6_000);
      void connectLive();
      return;
    }

    if (protocol === 3 && !isBinary && ['connecting', 'captions', 'draining', 'finalizing'].includes(phase)) {
      let command;
      try { command = JSON.parse(data.toString()); } catch { /* 아래에서 거절 */ }
      if (command?.type === 'cancel') {
        clientCancelled = true;
        return end();
      }
    }

    if (phase === 'captions' && protocol >= 2 && !isBinary) {
      let command;
      try { command = JSON.parse(data.toString()); } catch { /* 아래에서 거절 */ }
      if (command?.type !== 'finish' || command.bytes !== pcmBytes || pcmBytes < 3_200) {
        return end(400, '마지막 음성 데이터가 일치하지 않습니다.');
      }
      phase = 'draining';
      finishStartedAt = performance.now();
      clearTimeout(deadline);
      // 완료된 인식 상태를 보존합니다. 후속 음성 유무와 미확정 원문은 재사용 전 확인합니다.
      deadline = setTimeout(() => void finishTranslation(true), 2_400);
      scheduleFinalCheck();
      try {
        liveSession.sendRealtimeInput({ audioStreamEnd: true });
      } catch {
        liveFailed = true;
        void finishTranslation();
      }
      return;
    }

    if (phase !== 'captions' || !isBinary || data.length === 0 ||
        data.length > LIVE_CHUNK_BYTES || data.length % 2 !== 0) {
      return end(400, '음성 데이터 형식이 올바르지 않습니다.');
    }

    pcmBytes += data.length;
    if (pcmBytes > MAX_AUDIO_BYTES) {
      return end(413, `${MAX_AUDIO_SECONDS}초 녹음 한도를 초과했습니다.`);
    }
    if (protocol >= 2) audioParts.push(Buffer.from(data));

    try {
      liveSession.sendRealtimeInput({
        audio: { data: data.toString('base64'), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` },
      });
    } catch {
      end(502, '실시간 음성을 전송하지 못했습니다.');
    }
  });
  client.on('close', () => {
    if (protocol === 3 && ['draining', 'finalizing'].includes(phase)) clientCancelled = true;
    end();
  });
  client.on('error', () => end());
});
