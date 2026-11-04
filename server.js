// server.js
import express from 'express';
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = 'gemini-2.5-flash';
const LINE_WIDTH = 28;                    // 글래스 한 줄 글자 수 (한글 기준, 실기기에서 조정)
const DIVIDER = '-'.repeat(LINE_WIDTH);

const SYSTEM_INSTRUCTION = `
너는 스마트 글래스 터미널용 실시간 통역기다.
상대방의 언어를 자동 인식하여 아래 포맷으로만 출력하라.

[들린 말] 원문 (감지 언어)
[번  역] 자연스러운 한국어 번역
${DIVIDER}
[1. 긍정]
 • 원어: (답변) / 영어: (English)
 • 발음: (원어 한글발음) / (영어 한글발음)
 • 의미: 한국어 뜻
[2. 부정]
 • 원어: (답변) / 영어: (English)
 • 발음: (원어 한글발음) / (영어 한글발음)
 • 의미: 한국어 뜻
[3. 질문]
 • 원어: (답변) / 영어: (English)
 • 발음: (원어 한글발음) / (영어 한글발음)
 • 의미: 한국어 뜻

규칙:
1. 위 포맷 외 어떤 문장도 출력하지 말 것. 인사, 설명, 사족, 마크다운 기호(*, #, \`) 금지.
2. 상대 언어가 영어이면 "원어"와 "영어"를 따로 쓰지 말고 영어 한 번만 표기하고, 발음도 한 번만 표기할 것.
3. 한 줄은 최대 ${LINE_WIDTH}자(한글 기준, 영문·숫자는 2자를 1자로 계산). 넘으면 줄바꿈하고 다음 줄은 공백 3칸으로 들여쓸 것.
4. 답변 예시는 짧고 실용적인 한 문장으로 쓸 것.
`.trim();

const app = express();
app.use(express.json({ limit: '10kb' }));

// 최소한의 접근 제어: 앱과 프록시가 공유하는 토큰
app.use((req, res, next) => {
  if (req.get('x-app-token') !== process.env.APP_TOKEN) {
    return res.status(401).end();
  }
  next();
});

app.post('/translate', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).end();

  const controller = new AbortController();
  req.on('close', () => controller.abort()); // 클라이언트가 끊으면 생성 중단

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const stream = await ai.models.generateContentStream({
      model: MODEL,
      contents: text,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.3,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingBudget: 0 }, // 추론 끄기 (지연 최소화)
        abortSignal: controller.signal,
      },
    });

    for await (const chunk of stream) {
      if (chunk.text) res.write(chunk.text);
    }
  } catch (err) {
    if (!controller.signal.aborted) res.write(`\n[오류] ${err.message}`);
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
