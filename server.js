import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = process.env.PORT || 3000;

// CORS 전체 허용 (안경 웹뷰 및 로컬 테스트 허용)
app.use(cors({ origin: '*' }));
app.use(express.json());

// 1. 헬스체크 엔드포인트 (브라우저 직접 접속 확인용)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.status(200).send('G2 Translator Backend is Running');
});

// ==========================================
// ★ [추가된 위치] 안경 HUD 실시간 창구
// ==========================================
let latestText = "Server Online!\nReady for stream";

// 안경(G2)이 1초마다 최신 번역문을 조회하는 창구
app.get('/latest-translation', (req, res) => {
  res.status(200).json({ text: latestText });
});

// 외부에서 직접 텍스트를 안경 화면으로 밀어넣는 창구
app.post('/push-translation', (req, res) => {
  const { text } = req.body;
  if (text) latestText = text;
  res.status(200).json({ ok: true, text: latestText });
});
// ==========================================

// 2. Gemini 번역 엔드포인트
app.post('/translate', async (req, res) => {
  try {
    const { text, targetLang = 'ko' } = req.body;

    if (!text) {
      return res.status(400).json({ error: '텍스트가 입력되지 않았습니다.' });
    }

    const ai = new GoogleGenAI(); // 환경변수 GEMINI_API_KEY 자동 참조
    const prompt = `당신은 Even Realities G2 스마트 안경 전용 통역사입니다.
입력된 문장을 문맥에 맞게 ${targetLang === 'ko' ? '한국어' : '영어'}로 직관적이고 간결하게 번역하고,
사용자가 이어서 말할 수 있는 짧은 답변 선택지 3개를 제안하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "translation": "번역문",
  "suggestions": ["1. 답변1", "2. 답변2", "3. 답변3"]
}

입력 텍스트: "${text}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const result = JSON.parse(response.text.trim());

    // ★ 번역이 성공하면 안경 HUD에 표시될 문구를 자동으로 갱신
    latestText = `${result.translation}`;

    return res.status(200).json(result);

  } catch (error) {
    console.error('번역 처리 중 에러:', error);
    return res.status(500).json({
      error: 'Translation failed',
      message: error.message,
      translation: '번역 처리 실패 (서버 로그 확인)',
      suggestions: ['다시 시도']
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
