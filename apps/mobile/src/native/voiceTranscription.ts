import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import type { DictationLanguage } from "../lib/dictationLanguage";

export function getLocalVoiceTranscriber(_language?: DictationLanguage): VoiceTranscriber | null {
  return null;
}
