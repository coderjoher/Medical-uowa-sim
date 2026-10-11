import { h, mount } from "../ui.js";

/** Camera notice before tracking starts (PRD: privacy). The student can always choose mouse. */
export function consentScreen(choose: (mode: "hand" | "mouse") => void): void {
  mount(
    h(
      "main.center",
      h(
        "div.card.narrow",
        h("h1", "Hand tracking"),
        h("p", "This case can be controlled with your hand in front of the webcam."),
        h(
          "ul",
          h("li", "The camera image is processed only inside this browser."),
          h("li", "No video or images are stored or sent to the server."),
          h("li", "You can switch to the mouse at any time; your attempt is not affected."),
        ),
        h("div.row", h("button.primary.big", { on: { click: () => choose("hand") } }, "Use hand tracking"), h("button.big", { on: { click: () => choose("mouse") } }, "Use the mouse")),
      ),
    ),
  );
}
