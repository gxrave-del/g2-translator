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

app.post('/translate', async (req, res) => {
  try {
    const token = req.headers['x-app-token'];
    if (token && token !== APP_TOKEN) {
      return res.status(401).send('토큰 인증 실패: APP_TOKEN 불일치');
    }

    const { text } = req.body;
    if (!text) {
      return res.status(400).send('음성 텍스트가 없습니다.');
    }

    if (!apiKey) {
      return res.status(500).send('서버에 GEMINI_API_KEY가 없습니다.');
    }

    console.log('[음성 수신]:', text);

    // 실제 확인된 공식 모델 gemini-2.5-flash 호출
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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

    if (!apiRes.ok) {
      throw new Error(`Google API 호출 실패 (${apiRes.status}): ${data.error?.message || JSON.stringify(data)}`);
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '번역 결과 텍스트를 찾지 못했습니다.';
    console.log('[통역 생성 성공]:', reply);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(reply);

  } catch (err) {
    console.error('[서버 통역 실패]:', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`[API 오류 상세]\n${err.message || String(err)}`);
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
