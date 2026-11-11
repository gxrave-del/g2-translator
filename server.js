import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3000);

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// G2 안경 렌즈 HUD 표시용 텍스트 (초기값)
let latestText = "Server Online!\nReady for stream";

// 1. 헬스체크
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter', timestamp: new Date().toISOString() });
});

// 2. 스마트폰 전용 음성 마이크 리모컨 UI (onend 복구, textContent 적용)
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>G2 Translator Mic</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121212; color: #fff; text-align: center; padding: 24px; margin: 0; }
    h1 { font-size: 20px; color: #00ff66; margin-bottom: 6px; }
    p { font-size: 13px; color: #aaa; margin-top: 0; }
    .mode-select { margin: 18px 0; }
    select { padding: 12px; font-size: 15px; border-radius: 8px; background: #222; color: #fff; border: 1px solid #444; width: 100%; max-width: 320px; }
    .btn-record { width: 100%; max-width: 320px; height: 68px; font-size: 18px; font-weight: bold; border-radius: 34px; border: none; background: #00ff66; color: #000; cursor: pointer; }
    .btn-record.recording { background: #ff334b; color: #fff; }
    .status-box { background: #1e1e1e; border-radius: 12px; padding: 16px; margin: 20px auto; max-width: 320px; min-height: 50px; font-size: 14px; border: 1px solid #333; text-align: left; white-space: pre-wrap; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>G2 HUD Translator</h1>
  <p>스마트폰 마이크 입력 ➔ G2 안경 렌즈 투사</p>

  <div class="mode-select">
    <select id="langMode">
      <option value="ko">영어 듣기 ➔ 안경에 한국어로 표시</option>
      <option value="en">한국어 말하기 ➔ 안경에 영어로 표시</option>
    </select>
  </div>

  <button id="recBtn" class="btn-record">🎙️ 터치하고 말하기</button>

  <div class="status-box" id="resultBox">대기 중...</div>

  <script>
    const recBtn = document.getElementById('recBtn');
    const resultBox = document.getElementById('resultBox');
    const langMode = document.getElementById('langMode');

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      resultBox.textContent = "현재 브라우저에서 음성 인식을 지원하지 않습니다. Chrome을 이용해 주세요.";
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
        if (!isRecording) {
          activeLang = langMode.value;
          recognizer.lang = activeLang === 'ko' ? 'en-US' : 'ko-KR';
          try {
            recognizer.start();
            isRecording = true;
            recBtn.textContent = "🛑 듣는 중... (터치 시 중지)";
            recBtn.classList.add('recording');
            resultBox.textContent = "음성을 듣고 있습니다...";
          } catch (e) {
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
        resultBox.textContent = "인식: " + spokenText + "\n번역 요청 중...";

        try {
          const res = await fetch('/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: spokenText, targetLang: activeLang })
          });
          const data = await res.json();
          if (res.ok && data.translation) {
            resultBox.textContent = "원문: " + spokenText + "\n번역: " + data.translation;
          } else {
            resultBox.textContent = "오류: " + (data.error || '번역 실패');
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

// 3. G2 안경 렌즈 폴링 창구 (캐시 방지 헤더)
app.get('/latest-translation', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).json({ text: latestText });
});

// 4. 직접 텍스트 푸시 창구
app.post('/push-translation', (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text === 'string' && text.trim()) {
    latestText = text.trim();
  }
  res.status(200).json({ ok: true, text: latestText });
});

// 5. Gemini 3.5 Lite 기반 번역 핸들러 (AbortSignal + responseJsonSchema)
app.post('/translate', async (req, res) => {
  const { text, targetLang = 'ko' } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[오류] Render 환경 변수에 GEMINI_API_KEY가 없습니다.');
    return res.status(503).json({ error: 'Translation is not configured' });
  }

  const ai = new GoogleGenAI({ apiKey });
  const language = targetLang === 'ko' ? '한국어' : '영어';
  const signal = AbortSignal.timeout(8000);

  const contents = [
    `당신은 스마트 안경 전용 통역사입니다. 다음 발화를 ${language}로 문맥에 맞게 직관적이고 간결하게 번역하세요.`,
    '응답은 반드시 선언된 JSON 스키마 규격에 맞춰 translation과 suggestions 배열 3개를 반환하세요.',
    `발화 원문: ${JSON.stringify(text.trim())}`
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

    // 검증된 번역문만 HUD 상태값에 반영 (에러 시에는 이전 텍스트 유지)
    latestText = result.translation.trim();
    console.log('[번역 성공] 안경 HUD 갱신:', latestText);

    return res.status(200).json(result);

  } catch (error) {
    if (signal.aborted) {
      console.error('[Gemini 타임아웃] 8초 초과로 요청 중단');
      return res.status(504).json({ error: 'Gemini translation timed out' });
    }

    console.error('[Gemini API 오류]:', error);
    return res.status(500).json({ error: error.message || 'Translation failed' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter is listening on port ${port}`);
});
