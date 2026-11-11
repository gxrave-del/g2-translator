import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3000);

// 1. 보안 비밀키 설정 (Render 환경 변수의 G2_SECRET_KEY, 미설정 시 기본 안전값)
const G2_SECRET_KEY = process.env.G2_SECRET_KEY || 'g2-secure-token-2026';

// 2. CORS 엄격 제한
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-g2-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// 안경 HUD 송출용 상태 변수 (검증된 번역만 기록)
let latestText = "Server Online!\nReady for stream";

// 보안 인증 미들웨어 (인증 실패 시 Gemini 근처에도 못 가고 즉각 차단)
const requireAuth = (req, res, next) => {
  const clientKey = req.headers['x-g2-key'] || req.query.key;
  if (!clientKey || clientKey !== G2_SECRET_KEY) {
    console.warn(`[보안 경고] 허가되지 않은 접근 차단 IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: 접근 권한이 없습니다.' });
  }
  next();
};

// 1. 기본 헬스체크 (상태 확인용만 공개)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'g2-interpreter' });
});

// 2. 안경 HUD 폴링 창구 (안경 앱이 토큰을 달고 안전하게 조회)
app.get('/latest-translation', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).json({ text: latestText });
});

// 3. 비밀키가 없으면 아예 실행조차 안 되는 보안 번역 창구 (requireAuth 적용)
app.post('/translate', requireAuth, async (req, res) => {
  const { text, targetLang = 'ko' } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is missing' });
  }

  const ai = new GoogleGenAI({ apiKey });
  const language = targetLang === 'ko' ? '한국어' : '영어';
  
  // 5초 타임아웃: 5초 넘어가면 즉시 물리적 네트워크 소켓 절단 (과금 누수 방지)
  const signal = AbortSignal.timeout(5000);

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
        abortSignal: signal, // 물리적 네트워크 즉시 절단
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

    latestText = result.translation.trim();
    return res.status(200).json(result);

  } catch (error) {
    if (signal.aborted) {
      console.error('[Gemini 타임아웃] 소켓 강제 절단 완료');
      return res.status(504).json({ error: 'Translation timed out' });
    }
    console.error('[Gemini 에러]:', error);
    return res.status(500).json({ error: error.message });
  }
});

// 4. 보안 푸시 창구
app.post('/push-translation', requireAuth, (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text === 'string' && text.trim()) {
    latestText = text.trim();
  }
  res.status(200).json({ ok: true, text: latestText });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`g2-interpreter secure server running on port ${port}`);
});
