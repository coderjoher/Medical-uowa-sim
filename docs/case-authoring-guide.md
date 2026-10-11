# Writing a case — guide for academic authors

Each case is written in one spreadsheet, the **case template**. You don't need to install
anything special: Excel, LibreOffice or Google Sheets (downloaded as .xlsx) all work.

- Blank template: `content/templates/case-template.xlsx`, or **Case library → Download blank template** in the dashboard.
- Worked example: `content/templates/example-chest-pain-stemi.xlsx` (45-year-old man with chest pain).
- To revise a case that is already in the system: **Case library → Spreadsheet** on its row.

## The process

1. Fill in the template (start from the example if that is easier).
2. A second academic reviews it.
3. Upload it in **Case library → Import a case**, or send it to the dev team. It is checked straight
   away; any problem is listed with its tab, row and column, e.g.
   `History questions row 5 · Patient's answer — required`.
4. Click **Preview** and play the case exactly as a student would. Nothing is stored.
5. If it plays as intended, click **Sign off**. An admin then publishes it to the course.

Every upload becomes a new version. Results always stay linked to the version the student played.

## General rules

- Columns marked **\*** are required. Use the dropdowns wherever there is one.
- **Times** are case minutes from when the student starts the case.
- **Exam points, tests and drugs** must come from the shared lists on the **Lists** tab, so terms
  are the same in every case. If you need one that is missing, ask the dev team to add it.
- **Ids** marked *optional* are made for you. Where an id is required (vital events, questions),
  use short lowercase words joined by `_`, e.g. `o2_response`.
- **Feedback** columns are shown to the student in the debrief after the case.

## Tab by tab

| Tab | What to enter |
|---|---|
| Metadata | Case id, title, course, specialty, difficulty, time limit, learning objectives (one per row), authors (one per row), reviewer |
| Patient | 3D model (adult male / adult female / elderly / child), name, age, sex, chief complaint, the handover the student hears, and appearance cues (breathing, blinking, pain, coughing, sweating, pale) |
| History questions | One row per question the student can ask: topic, question, the patient's answer, **essential / useful / irrelevant**, and points. Essential and useful questions earn their points; each irrelevant one costs a little (Rubric tab) |
| Examination | One row per exam point with its finding (text, and optionally a sound or image file). Mark whether it is relevant and its points. Exam points not listed show "No abnormality found" |
| Vitals | Starting HR, BP, RR, SpO2 and temperature |
| Vital events | How vitals change. **timed**: at a case minute. **after_action**: some minutes after an action, e.g. oxygen raises SpO2. **deterioration**: at a case minute *unless* an action was done first, e.g. SpO2 falls if no oxygen by minute 5. Use one row per vital; rows with the same event id belong together. *Change* is **set** (go to the value) or **delta** (add the value); *over minutes* makes it gradual |
| Investigations | One row per test: result text, optional image/ECG file, turnaround in case minutes, whether it is indicated, points if indicated, penalty if not |
| Result values | Optional numeric results, e.g. troponin 860 ng/L flagged critical |
| Diagnosis | Every diagnosis the student can choose. Mark **one** as correct and give it points. Give points to acceptable differentials; leave the others blank |
| Management | Drugs and actions that matter: **correct**, **acceptable**, **neutral** or **harmful**. Optional time limit for full points (e.g. aspirin within 10 minutes) and points if later. For harmful actions the points are the penalty; mark **critical** if it alone should fail the case |
| Required order | Actions that must be given in order (comma separated) and the penalty if not |
| Questions | Checkpoint questions: when they appear (**time**, **after_action** or **before_diagnosis**), type (**single**, **multiple** or **short_list**), the question and its points |
| Question options | The options for each question; mark the right one(s) as correct. Multiple-answer questions give partial credit, and wrong picks cancel right ones |
| Rubric | Decision weight and question weight (must add up to 1, default 0.7 / 0.3), pass mark (%), penalty per irrelevant history question, and the maximum number of differentials |

## How the score works

The case score is decisions × decision weight + questions × question weight. Decision points
come from history, examination, investigations, diagnosis and management, minus safety
penalties. A **critical** action fails the case whatever the points. Movement and hand
gestures are never scored. If a rubric needs correcting after students have played, the dev
team can apply the correction and every stored attempt is re-scored.
