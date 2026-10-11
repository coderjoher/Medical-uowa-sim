import type { HandInput } from "./input/hand-input.js";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export interface Ctx {
  hand: HandInput;
  user: User | null;
  /** "hand" once calibrated, "mouse" when the student chose mouse or tracking is unavailable. */
  mode: "hand" | "mouse";
  /** Synthetic hand input for automated tests (?fakeHand=1). */
  fakeHand: boolean;
}
