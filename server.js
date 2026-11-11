import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3000);

// 환경 변수 검증 (비밀키 미설정 시 fallback 없이 경로 폐쇄)
const G2_READ_KEY = process.env.G2_READ_KEY?.trim();
const G2_WRITE_KEY = process.env.G2_WRITE_KEY?.trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim();

if (!G2_READ_KEY || !G2_WRITE_KEY) {
  console.warn('[경고] Render 환경 변수에 G2_READ_KEY 또는 G2_WRITE_KEY가 설정되지 않았습니다. 모든 보호 엔드포인트가 차단됩니다.');
}

// CORS 설정 (헤더에 x-g2-key 허용)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-g2-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON 파싱 전 크기 제한 (10KB 초과 요청 차단)
app.use(express.json({ limit: '10kb' }));

// G2 안경 렌즈 HUD 표시용 텍스트 상태
let latestText = "Server Online!\nReady for stream";

// ==========================================
// 1. 보안 인증 미들웨어 (헤더 전용, 역할 분리)
// ==========================================
const authenticate = (requiredRole) => {
  return (req, res, next) => {
    const key = req.headers['x-g2-key'];
    if (!key) {
      return res.status(401).json({ error: '인증 헤더(x-g2-key)가 누락되었습니다.' });
    }

    if (!G2_READ_KEY || !G2_WRITE_KEY) {
      return res.status(503).json({ error: '서버 인증 키가 구성되지 않았습니다.' });
    }

    if (requiredRole === 'read') {
      if (key === G2_READ_KEY || key === G2_WRITE_KEY) return next();
    } else if (requiredRole === 'write') {
      if (key === G2_WRITE_KEY) return next();
    }

    return res.status(403).json({ error: '권한이 없는 유효하지 않은 키입니다.' });
  };
};

// ==========================================
// 2. 비용 방어선 (Rate Limit & Concurrency Lock)
// ==========================================
let isTranslating = false;
let requestTimestamps = [];
let dailyCount = 0;
let lastResetDate = new Date().toDateString();

const checkRateLimit = (req, res, next) => {
  const now = Date.now();
  const today = new Date().toDateString();

  // 날짜 변경 시 일일 카운터 리셋
  if (today !== lastResetDate) {
    dailyCount = 0;
    lastResetDate = today;
  }

  // 1) 일일 최대 200회 제한
  if (dailyCount >= 200) {
    return res.status(429).json({ error: '일일 최대 번역 한도(200회)에 도달했습니다. 과금을 방지하기 위해 중단합니다.' });
  }

  // 2) 최근 1분간 타임스탬프 정리 (슬라이딩 윈도우)
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);

  // 3) 분당 최대 15회 제한
  if (requestTimestamps.length >= 15) {
    return res.status(429).json({ error: '요청이 너무 빠릅니다. (분당 최대 15회 제한) 잠시 후 다시 시도하세요.' });
  }

  // 4) 동시 요청 차단 (이전 번역이 처리 중일 때 중복 호출 방지)
  if (isTranslating) {
    return res.status(429).json({ error: '이전 번역 요청이 처리 중입니다.' });
  }

  requestTimestamps.push(now);
  dailyCount++;
  next();
};

// ==========================================
// 3. 엔드포인트 라우팅
// ==========================================

// [공개] 헬스체크
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter', timestamp: new Date().toISOString() });
});

// [공개] 스마트폰 마이크 UI (비밀키 입력창 내장, 소스에 키 노출 없음)
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
    <input type="password" id="writeKey" class="key-input" placeholder="스마트폰 쓰기 비밀키(G2_WRITE_KEY) 입력">
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

    // 키 로컬스토리지 보관
    writeKeyInput.value = localStorage.getItem('g2_write_key') || '';
    writeKeyInput.onchange = () => localStorage.setItem('g2_write_key', writeKeyInput.value.trim());

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
          alert('상단에 G2_WRITE_KEY 비밀키를 먼저 입력하세요.');
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
            console.error(e);
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
        resultBox.textContent = "인식: " + spokenText + "\\n번역 및 전송 요청 중...";

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
            resultBox.textContent = "오류 (" + res.status + "): " + (data.error || '번역 실패');
          }
        } catch (e) {
          resultBox.textContent = "전송 실패: " + e.message;
        }
      };

      recognizer.onerror = (e) => {
        resultBox.textContent = "마이크 인식 오류: " + e.error;
        resetButton();
      };
    }
  </script>
</body>
</html>
  `);
});

// [보안 읽기] G2 안경 렌즈 폴링 창구 (x-g2-key 인증 필수, 무인가 조회 차단)
app.get('/latest-translation', authenticate('read'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).json({ text: latestText });
});

// [보안 쓰기] 직접 텍스트 푸시
app.post('/push-translation', authenticate('write'), (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text === 'string' && text.trim()) {
    latestText = text.trim();
  }
  res.status(200).json({ ok: true, text: latestText });
});

// [보안 번역] Gemini 호출 (인증 ➔ 비용제한 ➔ 길이제한 ➔ AbortSignal)
app.post('/translate', authenticate('write'), checkRateLimit, async (req, res) => {
  const { text, targetLang = 'ko' } = req.body ?? {};

  // 입력값 검증 및 글자 수 제한 (비용 공격 방어)
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const cleanText = text.trim();
  if (cleanText.length > 150) {
    return res.status(400).json({ error: '발화 길이가 너무 깁니다 (최대 150자 제한)' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on server' });
  }

  isTranslating = true;
  const signal = AbortSignal.timeout(6000); // 6초 타임아웃
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const language = targetLang === 'ko' ? '한국어' : '영어';

  const contents = [
    `당신은 스마트 안경 전용 통역사입니다. 다음 발화를 ${language}로 문맥에 맞게 직관적이고 간결하게 번역하세요.`,
    '응답은 반드시 선언된 JSON 스키마 규격에 맞춰 translation과 suggestions 배열 3개를 반환하세요.',
    `발화 원문: ${JSON.stringify(cleanText)}`
  ].join('\n');

  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
      contents,
      config: {
        abortSignal: signal,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            translation: { type: 'string' },
            suggestions: {
              type: 'array',
              items: { type: 'string' },
              minItems: 3,
              maxItems: 3,
            },
          },
          required: ['translation', 'suggestions'],
        },
      },
    });

    const result = JSON.parse(response.text ?? '{}');
    if (typeof result.translation !== 'string' || !result.translation.trim()) {
      return res.status(502).json({ error: 'Gemini returned no translation' });
    }

    // 검증된 번역문만 HUD 상태값에 반영 (에러 시에는 마지막 정상 텍스트 유지)
    latestText = result.translation.trim();
    return res.status(200).json(result);

  } catch (error) {
    if (signal.aborted) {
      console.error('[Gemini 타임아웃] 6초 초과로 소켓 절단');
      return res.status(504).json({ error: 'Gemini translation timed out' });
    }
    console.error('[Gemini API 오류]:', error);
    return res.status(500).json({ error: error.message || 'Translation failed' });
  } finally {
    isTranslating = false; // 동시 실행 락 해제
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter secure server listening on port ${port}`);
});
