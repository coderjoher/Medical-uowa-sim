/**
 * Shared libraries reused across cases so terms stay consistent (PRD "Content rules").
 * A case may only reference ids that exist here; the validator enforces it.
 */

export type ExamTool = "hands" | "stethoscope" | "penlight" | "hammer" | "bp_cuff" | "thermometer";

export interface ExamPointDef {
  id: string;
  label: string;
  region: "head" | "neck" | "chest" | "abdomen" | "back" | "upper_limb" | "lower_limb" | "general";
  tool: ExamTool;
  view: "front" | "back";
}

export interface TestDef {
  id: string;
  label: string;
  category: "bedside" | "blood" | "imaging" | "cardiac" | "micro" | "other";
}

export interface ActionDef {
  id: string;
  label: string;
  kind: "drug" | "oxygen" | "fluid" | "procedure" | "referral";
  /** Default dose shown in the menu, e.g. "300 mg PO". */
  dose?: string;
}

export const EXAM_POINTS: readonly ExamPointDef[] = [
  { id: "general_inspection", label: "General inspection", region: "general", tool: "hands", view: "front" },
  { id: "pupils", label: "Pupils", region: "head", tool: "penlight", view: "front" },
  { id: "conjunctiva", label: "Conjunctiva", region: "head", tool: "penlight", view: "front" },
  { id: "jvp", label: "Jugular venous pressure", region: "neck", tool: "hands", view: "front" },
  { id: "carotid_pulse", label: "Carotid pulse", region: "neck", tool: "hands", view: "front" },
  { id: "radial_pulse", label: "Radial pulse", region: "upper_limb", tool: "hands", view: "front" },
  { id: "blood_pressure", label: "Blood pressure", region: "upper_limb", tool: "bp_cuff", view: "front" },
  { id: "temperature", label: "Temperature", region: "general", tool: "thermometer", view: "front" },
  { id: "heart_auscultation", label: "Heart auscultation", region: "chest", tool: "stethoscope", view: "front" },
  { id: "chest_auscultation_front", label: "Chest auscultation (front)", region: "chest", tool: "stethoscope", view: "front" },
  { id: "chest_auscultation_back", label: "Chest auscultation (back)", region: "back", tool: "stethoscope", view: "back" },
  { id: "chest_percussion", label: "Chest percussion", region: "chest", tool: "hands", view: "front" },
  { id: "chest_wall_palpation", label: "Chest wall palpation", region: "chest", tool: "hands", view: "front" },
  { id: "abdomen_palpation", label: "Abdomen palpation", region: "abdomen", tool: "hands", view: "front" },
  { id: "abdomen_auscultation", label: "Bowel sounds", region: "abdomen", tool: "stethoscope", view: "front" },
  { id: "calf_inspection", label: "Calves", region: "lower_limb", tool: "hands", view: "front" },
  { id: "ankle_oedema", label: "Ankle oedema", region: "lower_limb", tool: "hands", view: "front" },
  { id: "reflexes_knee", label: "Knee reflex", region: "lower_limb", tool: "hammer", view: "front" },
  { id: "reflexes_biceps", label: "Biceps reflex", region: "upper_limb", tool: "hammer", view: "front" },
  { id: "capillary_refill", label: "Capillary refill", region: "upper_limb", tool: "hands", view: "front" },
];

export const TESTS: readonly TestDef[] = [
  { id: "ecg", label: "12-lead ECG", category: "cardiac" },
  { id: "troponin", label: "Troponin", category: "blood" },
  { id: "fbc", label: "Full blood count", category: "blood" },
  { id: "u_and_e", label: "Urea & electrolytes", category: "blood" },
  { id: "lft", label: "Liver function tests", category: "blood" },
  { id: "crp", label: "CRP", category: "blood" },
  { id: "d_dimer", label: "D-dimer", category: "blood" },
  { id: "abg", label: "Arterial blood gas", category: "blood" },
  { id: "glucose", label: "Capillary glucose", category: "bedside" },
  { id: "lipids", label: "Lipid profile", category: "blood" },
  { id: "coag", label: "Coagulation screen", category: "blood" },
  { id: "blood_culture", label: "Blood cultures", category: "micro" },
  { id: "urinalysis", label: "Urine dipstick", category: "bedside" },
  { id: "cxr", label: "Chest X-ray", category: "imaging" },
  { id: "ct_head", label: "CT head", category: "imaging" },
  { id: "ct_chest", label: "CT chest", category: "imaging" },
  { id: "ctpa", label: "CT pulmonary angiogram", category: "imaging" },
  { id: "echo", label: "Echocardiogram", category: "cardiac" },
  { id: "abdo_us", label: "Abdominal ultrasound", category: "imaging" },
];

export const ACTIONS: readonly ActionDef[] = [
  { id: "aspirin", label: "Aspirin", kind: "drug", dose: "300 mg PO" },
  { id: "clopidogrel", label: "Clopidogrel", kind: "drug", dose: "300 mg PO" },
  { id: "ticagrelor", label: "Ticagrelor", kind: "drug", dose: "180 mg PO" },
  { id: "gtn", label: "GTN", kind: "drug", dose: "400 mcg SL" },
  { id: "morphine", label: "Morphine", kind: "drug", dose: "2.5-5 mg IV" },
  { id: "metoclopramide", label: "Metoclopramide", kind: "drug", dose: "10 mg IV" },
  { id: "heparin", label: "Heparin (LMWH)", kind: "drug", dose: "1 mg/kg SC" },
  { id: "salbutamol", label: "Salbutamol", kind: "drug", dose: "5 mg nebulised" },
  { id: "ipratropium", label: "Ipratropium", kind: "drug", dose: "500 mcg nebulised" },
  { id: "prednisolone", label: "Prednisolone", kind: "drug", dose: "40 mg PO" },
  { id: "hydrocortisone", label: "Hydrocortisone", kind: "drug", dose: "100 mg IV" },
  { id: "amoxicillin", label: "Amoxicillin", kind: "drug", dose: "500 mg PO" },
  { id: "co_amoxiclav", label: "Co-amoxiclav", kind: "drug", dose: "1.2 g IV" },
  { id: "paracetamol", label: "Paracetamol", kind: "drug", dose: "1 g PO" },
  { id: "ibuprofen", label: "Ibuprofen", kind: "drug", dose: "400 mg PO" },
  { id: "furosemide", label: "Furosemide", kind: "drug", dose: "40 mg IV" },
  { id: "adrenaline_im", label: "Adrenaline", kind: "drug", dose: "0.5 mg IM" },
  { id: "insulin", label: "Insulin (actrapid)", kind: "drug", dose: "per protocol" },
  { id: "sildenafil", label: "Sildenafil", kind: "drug", dose: "50 mg PO" },
  { id: "oxygen", label: "Oxygen", kind: "oxygen", dose: "target SpO2 94-98%" },
  { id: "iv_fluids", label: "IV fluids", kind: "fluid", dose: "500 mL crystalloid" },
  { id: "iv_access", label: "IV access", kind: "procedure" },
  { id: "cardiac_monitoring", label: "Cardiac monitoring", kind: "procedure" },
  { id: "refer_cardiology", label: "Refer to cardiology (PCI)", kind: "referral" },
  { id: "refer_medicine", label: "Refer to medical team", kind: "referral" },
  { id: "refer_surgery", label: "Refer to surgical team", kind: "referral" },
  { id: "refer_icu", label: "Refer to ICU", kind: "referral" },
  { id: "discharge", label: "Discharge home", kind: "referral" },
];

const byId = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));
export const EXAM_POINTS_BY_ID = byId(EXAM_POINTS);
export const TESTS_BY_ID = byId(TESTS);
export const ACTIONS_BY_ID = byId(ACTIONS);
