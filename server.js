import express from 'express';

const app = express();
const port = process.env.PORT || 10000;
const APP_TOKEN = process.env.APP_TOKEN || 'my_g2_secret_1234';

// CORS 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const apiKey = process.env.GEMINI_API_KEY;

const SYSTEM_PROMPT = `당신은 Even Realities G2 스마트 안경 전용 동시통역 엔진입니다.
상대방 외국어를 듣고 반드시 아래 양식으로만 간결하게 출력하세요:

[한국어 번역]
(자연스러운 번역 문장)

[추천 회신 답변]
1. 긍정: (원어) / (한글발음) / (한국어 뜻)
2. 거절/대안: (원어) / (한글발음) / (한국어 뜻)
3. 역질문: (원어) / (한글발음) / (한국어 뜻)`;

// 순차적으로 시도할 모델 후보군
const CANDIDATE_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash-latest',
  'gemini-pro',
  'gemini-1.0-pro'
];

app.post('/translate', async (req, res) => {
  try {
    const token = req.headers['x-app-token'];
    if (token && token !== APP_TOKEN) {
      return res.status(401).send('토큰 인증 실패');
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).send('음성 텍스트가 없습니다.');
    }

    if (!apiKey) {
      return res.status(500).send('서버에 GEMINI_API_KEY 환경변수가 없습니다.');
    }

    console.log('[음성 수신]:', text);

    let lastError = null;
    let reply = null;

    // 지원되는 모델을 순차 탐색하여 성공 시 즉시 반환
    for (const model of CANDIDATE_MODELS) {
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        
        const apiRes = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: `${SYSTEM_PROMPT}\n\n[입력된 음성]: ${text}` }]
              }
            ],
            generationConfig: {
              temperature: 0.3
            }
          })
        });

        const data = await apiRes.json();

        if (apiRes.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          reply = data.candidates[0].content.parts[0].text;
          console.log(`[통역 성공 - 사용된 모델: ${model}]`);
          break;
        } else {
          lastError = data.error?.message || JSON.stringify(data);
          console.warn(`[모델 ${model} 실패]:`, lastError);
        }
      } catch (e) {
        lastError = e.message;
      }
    }

    if (reply) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(reply);
    }

    // 모든 모델 실패 시, 현재 API 키에서 사용 가능한 모델 목록을 조회해 클라이언트에 표시
    let availableModels = '조회 실패';
    try {
      const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      const listData = await listRes.json();
      if (listData.models) {
        availableModels = listData.models.map(m => m.name.replace('models/', '')).join(', ');
      } else {
        availableModels = listData.error?.message || JSON.stringify(listData);
      }
    } catch (listErr) {
      availableModels = listErr.message;
    }

    throw new Error(`모든 모델 호출 실패. (마지막 에러: ${lastError})\n\n[내 API 키로 사용 가능한 모델 목록]:\n${availableModels}`);

  } catch (err) {
    console.error('[서버 통역 실패]:', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`[API 오류 상세]\n${err.message || String(err)}`);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
