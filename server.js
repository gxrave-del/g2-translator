import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3000);

// CORS 수동 헤더 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// 안경 HUD용 최신 자막 변수
let latestText = "Server Online!\nReady for stream";

// 1. 헬스체크
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter', timestamp: new Date().toISOString() });
});

// 스마트폰 브라우저 전용 마이크 입력 웹페이지
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>G2 Translator Mic</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #111; color: #fff; text-align: center; padding: 25px; margin: 0; }
    h1 { font-size: 20px; color: #00ff66; margin-bottom: 5px; }
    p { font-size: 13px; color: #888; margin-top: 0; }
    .status-box { background: #222; border-radius: 12px; padding: 15px; margin: 20px 0; min-height: 50px; font-size: 16px; border: 1px solid #333; }
    .btn-record { width: 100%; max-width: 300px; height: 65px; font-size: 18px; font-weight: bold; border-radius: 35px; border: none; background: #00ff66; color: #000; cursor: pointer; margin-bottom: 15px; }
    .btn-record.recording { background: #ff334b; color: #fff; animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: 0.8; } to { opacity: 1; transform: scale(1.02); } }
    .mode-select { margin-bottom: 20px; }
    select { padding: 10px 15px; font-size: 15px; border-radius: 8px; background: #222; color: #fff; border: 1px solid #444; }
  </style>
</head>
<body>
  <h1>G2 Glasses Translator</h1>
  <p>스마트폰 마이크로 말하면 안경에 자막이 뜹니다</p>

  <div class="mode-select">
    <label>번역 방향: </label>
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
      resultBox.innerText = "이 브라우저는 음성 인식을 지원하지 않습니다. Safari 또는 Chrome을 사용하세요.";
      recBtn.disabled = true;
    } else {
      const recognizer = new SpeechRecognition();
      recognizer.interimResults = false;
      let isRecording = false;

      recBtn.onclick = () => {
        if (!isRecording) {
          recognizer.lang = langMode.value === 'ko' ? 'en-US' : 'ko-KR';
          recognizer.start();
          recBtn.innerText = "🛑 듣는 중... (터치 시 중지)";
          recBtn.classList.add('recording');
          resultBox.innerText = "음성을 인식하고 있습니다...";
          isRecording = true;
        } else {
          recognizer.stop();
          recBtn.innerText = "🎙️ 터치하고 말하기";
          recBtn.classList.remove('recording');
          isRecording = false;
        }
      };

      recognizer.onresult = async (event) => {
        const spokenText = event.results[0][0].transcript;
        resultBox.innerText = "인식됨: " + spokenText + " ➔ 번역 중...";
        recBtn.innerText = "🎙️ 터치하고 말하기";
        recBtn.classList.remove('recording');
        isRecording = false;

        try {
          const res = await fetch('/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: spokenText, targetLang: langMode.value })
          });
          const data = await res.json();
          resultBox.innerHTML = "<b>원문:</b> " + spokenText + "<br><b>안경 전송:</b> " + data.translation;
        } catch (e) {
          resultBox.innerText = "번역 전송 실패: " + e.message;
        }
      };

      recognizer.onerror = (e) => {
        resultBox.innerText = "마이크 인식 오류: " + e.error;
        recBtn.innerText = "🎙️ 터치하고 말하기";
        recBtn.classList.remove('recording');
        isRecording = false;
      };
    }
  </script>
</body>
</html>
  `);
});
// 2. 안경 HUD 폴링 창구 (캐시 방지 헤더 적용)
app.get('/latest-translation', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.status(200).json({ text: latestText });
});

// 3. 외부 텍스트 직접 푸시
app.post('/push-translation', (req, res) => {
  const { text } = req.body ?? {};
  if (text) latestText = text;
  res.status(200).json({ ok: true, text: latestText });
});

// 4. Gemini 번역 처리
app.post('/translate', async (req, res) => {
  try {
    const { text, targetLang = 'ko' } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Translation is not configured (Missing GEMINI_API_KEY)' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const language = targetLang === 'ko' ? '한국어' : '영어';

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      contents: [
        `당신은 스마트 안경 전용 통역사입니다. 다음 발화를 ${language}로 문맥에 맞게 직관적이고 간결하게 번역하세요.`,
        '반드시 {"translation":"번역문","suggestions":["답변1","답변2","답변3"]} 형식의 순수 JSON으로만 응답하세요.',
        `발화 원문: ${JSON.stringify(text.trim())}`
      ].join('\n'),
      config: { responseMimeType: 'application/json' },
    });

    const result = JSON.parse(response.text ?? '{}');
    if (!result.translation) {
      return res.status(502).json({ error: 'Gemini returned no translation' });
    }

    // 안경 화면에 즉시 노출되도록 자막 갱신
    latestText = result.translation;

    return res.status(200).json(result);
  } catch (error) {
    console.error('번역 처리 에러:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter is listening on port ${port}`);
});
