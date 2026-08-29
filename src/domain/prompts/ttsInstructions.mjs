// ③ TTS の演技指示（instructions）と話者→声の対応（純粋な文字列データ）。
// openai.fm の公式プリセットはすべて「ラベル: 内容」を空行で区切る形式。

// openai.fm の公式プリセットはすべて「ラベル: 内容」を空行で区切る形式。
// 共通ブロック（全シーン同一）— 映画予告ナレーターの声そのものを定義する。
export const NARRATION_COMMON = `Voice Affect: A Japanese TV movie-trailer announcer — bright, forward, and high-energy. Voice placed high and forward in the mask, not down in the chest. Big projection, as if calling across a packed theater.

Tone: Excited, urgent, and larger-than-life. Every line is an announcement. Absolutely serious about the content — never mocking, never sleepy, never conversational, never monotone.

Pacing: Very fast and punchy — noticeably faster than normal speech. Attack each phrase hard and immediately. Pauses only where "……" appears, and keep them short and tense. Never drag a syllable.

Intonation: Strongly melodic and dynamic. Swing the pitch widely: leap UP on the key noun or number of each line, then drop sharply for the ending. Alternate loud and soft within a single sentence. No two consecutive phrases at the same pitch or volume. Think of a sports announcer calling a decisive play.

Pronunciation: Crisp consonants, bright vowels, clear Japanese diction. Sentence endings land hard and clean, never trailing off.

Punctuation: "……" is a short, charged breath — the pitch drops into it and springs back out of it. A period is a sharp, complete stop.`;

// scene_type 別ブロック。全体を高テンションに保ちつつ、序盤→終盤で熱量をさらに上げる。
const NARRATION_BY_TYPE = {
  cold_open: `Emphasis: Bright and inviting, like the opening of a summer blockbuster spot. Energy already high, but with a smile in the voice. Lean into the time-setting words.

Emotion: Anticipation. Something big is about to be announced.`,
  setup: `Emphasis: Snap the pivot word ("しかし") hard and lift the pitch right after it. Faster than the opening.

Emotion: Alarm breaking through the excitement — the announcer has just seen the twist.`,
  turn: `Emphasis: Hit every number and noun like a drum. Rapid-fire, almost breathless, pitch high.

Emotion: Peak intensity. This is the moment the audience must not look away from.`,
  montage: `Emphasis: Maximum drive. Ride the rhythm of the cuts — short, hammering phrases, rising pitch to the end.

Emotion: Thrill of the counter-attack. Loud, fast, exhilarated.`,
  resolve: `Emphasis: Highest energy of the whole piece, then a hard, clean stop on the last word. Pitch peaks on the final phrase.

Emotion: Cliffhanger. Nothing is resolved — sell the question, not the answer.`,
};

export function narrationInstructions(sceneType) {
  const extra = NARRATION_BY_TYPE[sceneType] ?? NARRATION_BY_TYPE.setup;
  return `${NARRATION_COMMON}\n\n${extra}`;
}

/**
 * button_line（タイトル後の落ち）の演技指示。
 * ここだけは「予告の声」を降ろして、現実に戻った素の一言にする（笑いの落差はここで作る）。
 */
export function buttonInstructions() {
  return `Voice Affect: An ordinary person in an ordinary office. No trailer voice at all — the performance drops completely.

Tone: Flat, tired, matter-of-fact. Slightly deflated. Absolutely not dramatic.

Pacing: Normal conversational speed. One short line, then stop.

Emotion: Resignation. The crisis is over and the paperwork is not.

Pronunciation: Everyday spoken Japanese, relaxed and unprojected.

Punctuation: End plainly. No emphasis, no held vowels, no reverb-worthy finish.`;
}

/** セリフの演技指示。scene_type で強度を変える。 */
export function dialogueInstructions(sceneType) {
  const intensity =
    {
      turn: `Emotion: Urgent and clipped — a warning thrown across a room. Volume is raised but controlled.`,
      montage: `Emotion: Shouted over noise. Hard, commanding, no hesitation.`,
      resolve: `Emotion: Low and spent, close to the microphone. Nearly a whisper, but absolutely certain.`,
    }[sceneType] ?? `Emotion: Urgent and clipped, thrown across a room.`;
  return `Voice Affect: A character inside the scene, not a narrator. Real, unpolished, caught mid-action.

Tone: Direct address to another person who is right there. Never announce, never perform.

Pacing: Fast. One breath, one line, then stop.

${intensity}

Pronunciation: Natural spoken Japanese, slightly rough at the edges.

Punctuation: End hard. No trailing softness.`;
}

/** speaker → TTS voice。ナレーション voice とは必ず別の声にする。 */
export const SPEAKER_VOICES = {
  hero:   ["echo", "verse"],      // 若手男性
  senpai: ["nova", "marin"],      // 30 代前半女性
  boss:   ["onyx", "ash"],        // 50 代男性
  // 旧台本互換
  male_young: ["echo", "verse"], female_young: ["nova", "marin"], female_mature: ["nova", "marin"], male_mature: ["onyx", "ash"],
  none: ["echo", "onyx"],
};

export function dialogueVoice(speaker, narVoice) {
  const cands = SPEAKER_VOICES[speaker] ?? SPEAKER_VOICES.none;
  return cands.find((v) => v !== narVoice) ?? "echo";
}
