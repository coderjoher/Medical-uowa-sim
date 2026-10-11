import { describe, expect, it } from "vitest";
import { CaseClock, computeVitals, dueQuestions, investigationStatus } from "../src/index.js";
import { act, loadRefCase, min } from "./helpers.js";

const c = loadRefCase();

describe("vital signs engine", () => {
  it("starts at the initial values", () => {
    expect(computeVitals(c.vitals, [], 0).values).toEqual(c.vitals.initial);
  });

  it("applies timed changes on schedule, ramping over their duration", () => {
    const log = [act("management.give", "oxygen", 1)];
    expect(computeVitals(c.vitals, log, min(7.9)).values.hr).toBe(98);
    expect(computeVitals(c.vitals, log, min(9)).values.hr).toBe(103); // half way through a +10 over 2 min
    expect(computeVitals(c.vitals, log, min(10)).values.hr).toBe(108);
    expect(computeVitals(c.vitals, log, min(15)).values.hr).toBe(108);
  });

  it("applies action-triggered changes after their delay", () => {
    const log = [act("management.give", "oxygen", 2)];
    expect(computeVitals(c.vitals, log, min(2.4)).values.spo2).toBe(93);
    expect(computeVitals(c.vitals, log, min(4.5)).values.spo2).toBe(96);
  });

  it("does not apply action changes before the action happens", () => {
    const log = [act("management.give", "oxygen", 10)];
    expect(computeVitals(c.vitals, log, min(4)).values.spo2).toBe(93);
  });

  it("deteriorates on time when oxygen is not given within 5 minutes", () => {
    const s = computeVitals(c.vitals, [], min(8));
    expect(s.values.spo2).toBe(88);
    expect(s.values.rr).toBe(26);
    expect(s.messages).toEqual(["The patient is becoming more breathless."]);
  });

  it("cancels the deterioration if oxygen is given first", () => {
    const s = computeVitals(c.vitals, [act("management.give", "oxygen", 4)], min(8));
    expect(s.values.spo2).toBe(96);
    expect(s.firedEvents).not.toContain("hypoxia");
  });

  it("still deteriorates if oxygen comes after the deadline, then recovers", () => {
    const log = [act("management.give", "oxygen", 6)];
    expect(computeVitals(c.vitals, log, min(6)).firedEvents).toContain("hypoxia");
    expect(computeVitals(c.vitals, log, min(12)).values.spo2).toBe(96);
  });

  it("shows GTN-induced hypotension", () => {
    const s = computeVitals(c.vitals, [act("management.give", "gtn", 3)], min(7));
    expect(s.values.sbp).toBe(78);
  });

  it("is deterministic for the same log and time", () => {
    const log = [act("management.give", "morphine", 2), act("management.give", "oxygen", 3)];
    expect(computeVitals(c.vitals, log, min(11))).toEqual(computeVitals(c.vitals, [...log].reverse(), min(11)));
  });
});

describe("checkpoints and investigations", () => {
  it("pauses for a question after its trigger action, until answered", () => {
    expect(dueQuestions(c.questions, [], min(1)).map((q) => q.id)).toEqual([]);
    const log = [act("investigation.order", "ecg", 1)];
    expect(dueQuestions(c.questions, log, min(1)).map((q) => q.id)).toEqual(["q_ecg_territory"]);
    log.push(act("question.answer", "q_ecg_territory", 1.5, { selected: ["rca"] }));
    expect(dueQuestions(c.questions, log, min(2))).toEqual([]);
  });

  it("raises timed and before-diagnosis checkpoints", () => {
    expect(dueQuestions(c.questions, [], min(12)).map((q) => q.id)).toEqual(["q_reperfusion"]);
    expect(dueQuestions(c.questions, [], min(1), { aboutToDiagnose: true }).map((q) => q.id)).toEqual(["q_nitrate_ci"]);
  });

  it("releases investigation results only after the turnaround time", () => {
    const log = [act("investigation.order", "troponin", 2)];
    const [before] = investigationStatus(c.investigations, log, min(7.9));
    const [after] = investigationStatus(c.investigations, log, min(8));
    expect(before).toMatchObject({ id: "troponin", ready: false, readyAtMs: min(8) });
    expect(after?.ready).toBe(true);
    expect(investigationStatus(c.investigations, [], min(30))).toEqual([]);
  });
});

describe("case clock", () => {
  it("excludes paused time and survives serialization", () => {
    let now = 1000;
    const clock = new CaseClock(() => now);
    clock.start();
    now += 5000;
    clock.pause();
    now += 60_000;
    expect(clock.elapsedMs()).toBe(5000);
    clock.start();
    now += 2000;
    const saved = clock.serialize();
    expect(saved.accumulatedMs).toBe(7000);
    const restored = new CaseClock(() => now, saved);
    expect(restored.running).toBe(false);
    restored.start();
    now += 1000;
    expect(restored.elapsedMs()).toBe(8000);
  });
});
