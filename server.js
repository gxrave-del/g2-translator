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

app.get('/', (req, res) => {
  res.status(200).send('G2 Translator Backend is Running');
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
