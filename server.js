import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const port = process.env.PORT || 10000;
const APP_TOKEN = process.env.APP_TOKEN || 'my_g2_secret_1234';

// CORS 설정
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Gemini API 초기화
const apiKey = process.env.GEMINI_API_KEY;
let genAI = null;
if (apiKey) {
  genAI = new GoogleGenerativeAI(apiKey);
} else {
  console.error("경고: GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.");
}

const SYSTEM_INSTRUCTION = `
당신은 Even Realities G2 스마트 안경 전용 동시통역 엔진입니다.
상대방의 외국어 음성을 분석하여 아래 서식대로 즉시 답변을 작성하세요:

[한국어 번역]
(정확하고 자연스러운 번역 문장)

[추천 회신 답변]
1. 긍정: (현지어 문장) / (한글 발음) / (한국어 뜻)
2. 거절/대안: (현지어 문장) / (한글 발음) / (한국어 뜻)
3. 역질문: (현지어 문장) / (한글 발음) / (한국어 뜻)
`;

app.post('/translate', async (req, res) => {
  try {
    const token = req.headers['x-app-token'];
    if (token && token !== APP_TOKEN) {
      return res.status(401).send('인증 실패: APP_TOKEN 불일치');
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).send('전송된 텍스트가 없습니다.');
    }

    if (!genAI) {
      return res.status(500).send('서버에 GEMINI_API_KEY가 없습니다.');
    }

    console.log('[음성 수신]:', text);

    const model = genAI.getGenerativeModel({
      model: 'gemini-1.5-flash-002',
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.3,
      }
    });

    const result = await model.generateContent(text);
    const response = await result.response;
    const reply = response.text();

    console.log('[Gemini 응답 생성 성공]:', reply);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(reply);
  } catch (err) {
    console.error('[Gemini 호출 에러]:', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`[API 오류 상세]\n${err.message || String(err)}`);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
