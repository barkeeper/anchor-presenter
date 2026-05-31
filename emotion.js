// emotion.js — zero-cost heuristic mood detection (no extra model download).
// Maps a reply's words + punctuation to a mood the face can wear.

const LEX = {
  joy:      ['happy','glad','great','awesome','love','wonderful','excellent','fun','delighted','yay','congratulations','nice','fantastic','amazing','enjoy','pleased','cheer','smile','haha','lol','excited','brilliant','perfect','thrilled'],
  sad:      ['sad','sorry','unfortunately','regret','afraid','miss','lonely','disappointed','unhappy','cry','grief','hurts','sigh','alas','tragic','heartbroken','depress'],
  anger:    ['angry','annoyed','furious','hate','terrible','awful','stupid','unacceptable','ridiculous','outrage','frustrated','no!','wrong','enough'],
  surprise: ['wow','whoa','really','surprising','unbelievable','incredible','suddenly','shocked','amazing','what?!','no way','astonish'],
  curious:  ['curious','wonder','interesting','perhaps','maybe','consider','imagine','hmm','question','explore','what if','how about','let us','let me think','intriguing'],
};

export function detectMood(text) {
  const t = ' ' + (text || '').toLowerCase() + ' ';
  const scores = { joy: 0, sad: 0, anger: 0, surprise: 0, curious: 0, neutral: 0.4 };
  for (const mood in LEX) for (const w of LEX[mood]) if (t.includes(w)) scores[mood] += 1;

  const bangs = (text.match(/!/g) || []).length;
  const qs = (text.match(/\?/g) || []).length;
  if (qs) scores.curious += Math.min(qs, 3) * 0.6;
  if (bangs) { scores.surprise += Math.min(bangs, 3) * 0.4; scores.joy += 0.2; }

  let best = 'neutral', bestV = scores.neutral;
  for (const m in scores) if (scores[m] > bestV) { best = m; bestV = scores[m]; }
  const intensity = Math.max(0, Math.min(1, best === 'neutral' ? 0.25 : 0.45 + bestV * 0.18));
  return { mood: best, intensity };
}
