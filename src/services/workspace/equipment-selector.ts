/** Real, local, dependency-free equipment selection/comparison for PVD/CVD/PECVD/plasma
 *  process equipment - no external API, no LLM, no vendor catalog. Configurations below are
 *  TECHNICAL CLASSES (categories of machine capability), never a real commercial brand or
 *  model - see EQUIPMENT_CONFIGURATIONS. Matching is a plain, transparent, testable pipeline:
 *  hard filters (physically impossible requirements exclude a configuration outright) followed
 *  by weighted scoring (see MATCH_WEIGHTS) of the survivors - never a hidden AI/opaque score. */

// ---------- enumerations (also drive UI <select> options) ----------

export const PURPOSES = ['deposition', 'etching', 'plasma_cleaning', 'surface_treatment'] as const;
export type Purpose = typeof PURPOSES[number];

export const TECHNOLOGIES = ['magnetron_pvd', 'vacuum_arc_fcva', 'pecvd', 'cvd', 'icp_rf_plasma', 'combined'] as const;
export type Technology = typeof TECHNOLOGIES[number];

export const SUBSTRATE_TYPES = ['wafer', 'parts', 'tooling', 'custom_geometry'] as const;
export type SubstrateType = typeof SUBSTRATE_TYPES[number];

export const MATERIAL_CLASSES = ['metals', 'nitrides', 'carbon_coatings', 'dielectrics', 'custom'] as const;
export type MaterialClass = typeof MATERIAL_CLASSES[number];

export const THROUGHPUT_CLASSES = ['rnd', 'small_batch', 'production'] as const;
export type ThroughputClass = typeof THROUGHPUT_CLASSES[number];

export const AUTOMATION_LEVELS = ['manual', 'semi_automatic', 'recipe_controlled', 'full_automatic'] as const;
export type AutomationLevel = typeof AUTOMATION_LEVELS[number];

export const CLEANROOM_CLASSES = ['not_required', 'iso8', 'iso7', 'iso6'] as const;
export type CleanroomClass = typeof CLEANROOM_CLASSES[number];

export const LABELS = {
  purpose: { deposition: 'Осаждение', etching: 'Травление', plasma_cleaning: 'Плазменная очистка', surface_treatment: 'Обработка поверхности' } satisfies Record<Purpose, string>,
  technology: { magnetron_pvd: 'Magnetron PVD', vacuum_arc_fcva: 'Vacuum arc / FCVA', pecvd: 'PECVD', cvd: 'CVD', icp_rf_plasma: 'ICP/RF plasma', combined: 'Комбинированная система' } satisfies Record<Technology, string>,
  substrate: { wafer: 'Пластина (wafer)', parts: 'Детали', tooling: 'Инструмент', custom_geometry: 'Произвольная геометрия' } satisfies Record<SubstrateType, string>,
  material: { metals: 'Металлы', nitrides: 'Нитриды', carbon_coatings: 'Углеродные покрытия', dielectrics: 'Диэлектрики', custom: 'Пользовательское значение' } satisfies Record<MaterialClass, string>,
  throughput: { rnd: 'R&D', small_batch: 'Мелкая серия', production: 'Производство' } satisfies Record<ThroughputClass, string>,
  automation: { manual: 'Ручное', semi_automatic: 'Полуавтоматическое', recipe_controlled: 'Рецептурное управление', full_automatic: 'Полностью автоматическое' } satisfies Record<AutomationLevel, string>,
  cleanroom: { not_required: 'Не требуется', iso8: 'ISO 8', iso7: 'ISO 7', iso6: 'ISO 6' } satisfies Record<CleanroomClass, string>,
};

// ---------- A-L: EquipmentRequirement (user input) ----------

export interface SourceRequirement {
  magnetronCount: number;
  arcSourceCount: number;
  icpRf: boolean;
  substrateBias: boolean;
  ionSource: boolean;
  combinedModeRequired: boolean;
}

export interface GasSystemRequirement {
  gasLines: number;
  processGases: string[];
  mfcRequired: boolean;
}

export interface PressureRange { minMbar: number; maxMbar: number }

export interface EquipmentRequirement {
  purpose: Purpose;
  technology: Technology;
  substrateType: SubstrateType;
  maxSizeMm: number;
  materialClass: MaterialClass;
  customMaterialNote?: string;
  maxProcessTempC: number;
  pressureRange: PressureRange;
  sources: SourceRequirement;
  gasSystem: GasSystemRequirement;
  throughputClass: ThroughputClass;
  automation: AutomationLevel;
  cleanroom: CleanroomClass;
  /** Free text - never participates in scoring (see requirement 9: no LLM, no hidden influence). */
  specialRequirements?: string;
}

// ---------- validation ----------

function assertFinite(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}: введите конечное число.`);
  return value;
}

function assertNonNegative(value: number, label: string): number {
  assertFinite(value, label);
  if (value < 0) throw new Error(`${label}: значение не может быть отрицательным.`);
  return value;
}

const DEPOSITION_TECHNOLOGIES: Technology[] = ['magnetron_pvd', 'vacuum_arc_fcva', 'pecvd', 'cvd', 'combined'];
const ETCH_CLEAN_TECHNOLOGIES: Technology[] = ['icp_rf_plasma', 'combined'];

export function validateRequirement(req: EquipmentRequirement): void {
  if (!PURPOSES.includes(req.purpose)) throw new Error('Назначение: выберите одно из допустимых значений.');
  if (!TECHNOLOGIES.includes(req.technology)) throw new Error('Технология: выберите одно из допустимых значений.');
  if (!SUBSTRATE_TYPES.includes(req.substrateType)) throw new Error('Подложка/изделие: выберите одно из допустимых значений.');
  if (!MATERIAL_CLASSES.includes(req.materialClass)) throw new Error('Материалы/процесс: выберите одно из допустимых значений.');
  if (!THROUGHPUT_CLASSES.includes(req.throughputClass)) throw new Error('Производительность: выберите одно из допустимых значений.');
  if (!AUTOMATION_LEVELS.includes(req.automation)) throw new Error('Автоматизация: выберите одно из допустимых значений.');
  if (!CLEANROOM_CLASSES.includes(req.cleanroom)) throw new Error('Cleanroom: выберите одно из допустимых значений.');

  assertFinite(req.maxSizeMm, 'Максимальный размер');
  if (req.maxSizeMm <= 0) throw new Error('Максимальный размер: значение должно быть больше 0.');

  assertFinite(req.maxProcessTempC, 'Максимальная температура процесса');
  if (req.maxProcessTempC < -50 || req.maxProcessTempC > 1500) throw new Error('Максимальная температура процесса: значение вне разумного диапазона (-50…1500°C).');

  assertFinite(req.pressureRange.minMbar, 'Минимальное давление');
  assertFinite(req.pressureRange.maxMbar, 'Максимальное давление');
  if (req.pressureRange.minMbar <= 0) throw new Error('Минимальное давление: значение должно быть больше 0.');
  if (req.pressureRange.maxMbar <= req.pressureRange.minMbar) throw new Error('Максимальное давление: должно быть больше минимального.');

  assertNonNegative(req.sources.magnetronCount, 'Количество магнетронов');
  assertNonNegative(req.sources.arcSourceCount, 'Количество arc-источников');
  assertNonNegative(req.gasSystem.gasLines, 'Количество газовых линий');
  if (!Number.isInteger(req.gasSystem.gasLines)) throw new Error('Количество газовых линий: введите целое число.');
  if (!Number.isInteger(req.sources.magnetronCount)) throw new Error('Количество магнетронов: введите целое число.');
  if (!Number.isInteger(req.sources.arcSourceCount)) throw new Error('Количество arc-источников: введите целое число.');

  if (req.purpose === 'etching' && !ETCH_CLEAN_TECHNOLOGIES.includes(req.technology)) {
    throw new Error(`Несовместимая комбинация: технология «${LABELS.technology[req.technology]}» не выполняет травление. Выберите ICP/RF plasma или комбинированную систему.`);
  }
  if (req.purpose === 'plasma_cleaning' && !ETCH_CLEAN_TECHNOLOGIES.includes(req.technology)) {
    throw new Error(`Несовместимая комбинация: технология «${LABELS.technology[req.technology]}» не выполняет плазменную очистку. Выберите ICP/RF plasma или комбинированную систему.`);
  }
  if (req.purpose === 'deposition' && !DEPOSITION_TECHNOLOGIES.includes(req.technology)) {
    throw new Error(`Несовместимая комбинация: технология «${LABELS.technology[req.technology]}» сама по себе не выполняет осаждение. Выберите PVD/CVD/PECVD или комбинированную систему.`);
  }
}

// ---------- EquipmentConfiguration: technical classes, NOT brands/models ----------

export interface EquipmentConfiguration {
  id: string;
  name: string;
  description: string;
  supportedPurposes: Purpose[];
  supportedTechnologies: Technology[];
  supportedSubstrateTypes: SubstrateType[];
  maxChamberSizeMm: number;
  supportedMaterialClasses: MaterialClass[];
  maxProcessTempC: number;
  pressureRange: PressureRange;
  sources: { magnetronCount: number; arcSourceCount: number; icpRf: boolean; substrateBias: boolean; ionSource: boolean; combinedModeSupported: boolean };
  gasSystem: { maxGasLines: number; mfcSupported: boolean };
  throughputClasses: ThroughputClass[];
  automationLevels: AutomationLevel[];
  cleanroomSupport: CleanroomClass[];
}

export const EQUIPMENT_CONFIGURATIONS: EquipmentConfiguration[] = [
  {
    id: 'research-magnetron-pvd', name: 'Research Magnetron PVD',
    description: 'Исследовательская установка магнетронного PVD с одной-двумя катодными позициями.',
    supportedPurposes: ['deposition', 'surface_treatment'], supportedTechnologies: ['magnetron_pvd'],
    supportedSubstrateTypes: ['wafer', 'parts', 'tooling', 'custom_geometry'], maxChamberSizeMm: 150,
    supportedMaterialClasses: ['metals', 'nitrides', 'dielectrics'], maxProcessTempC: 400,
    pressureRange: { minMbar: 1e-4, maxMbar: 1e-1 },
    sources: { magnetronCount: 2, arcSourceCount: 0, icpRf: false, substrateBias: true, ionSource: false, combinedModeSupported: false },
    gasSystem: { maxGasLines: 2, mfcSupported: true },
    throughputClasses: ['rnd'], automationLevels: ['manual', 'semi_automatic'], cleanroomSupport: ['not_required'],
  },
  {
    id: 'multi-cathode-pvd', name: 'Multi-Cathode PVD',
    description: 'Промышленная многокатодная PVD-платформа для серийного нанесения покрытий.',
    supportedPurposes: ['deposition'], supportedTechnologies: ['magnetron_pvd'],
    supportedSubstrateTypes: ['wafer', 'parts', 'tooling'], maxChamberSizeMm: 300,
    supportedMaterialClasses: ['metals', 'nitrides', 'dielectrics'], maxProcessTempC: 500,
    pressureRange: { minMbar: 1e-4, maxMbar: 1e-1 },
    sources: { magnetronCount: 6, arcSourceCount: 0, icpRf: false, substrateBias: true, ionSource: true, combinedModeSupported: false },
    gasSystem: { maxGasLines: 4, mfcSupported: true },
    throughputClasses: ['small_batch', 'production'], automationLevels: ['semi_automatic', 'recipe_controlled', 'full_automatic'], cleanroomSupport: ['not_required', 'iso8'],
  },
  {
    id: 'filtered-vacuum-arc', name: 'Filtered Vacuum Arc / FCVA',
    description: 'Установка фильтрованного вакуумно-дугового осаждения для износостойких и углеродных покрытий.',
    supportedPurposes: ['deposition'], supportedTechnologies: ['vacuum_arc_fcva'],
    supportedSubstrateTypes: ['parts', 'tooling'], maxChamberSizeMm: 250,
    supportedMaterialClasses: ['metals', 'carbon_coatings', 'nitrides'], maxProcessTempC: 450,
    pressureRange: { minMbar: 1e-5, maxMbar: 1e-2 },
    sources: { magnetronCount: 0, arcSourceCount: 4, icpRf: false, substrateBias: true, ionSource: false, combinedModeSupported: false },
    gasSystem: { maxGasLines: 2, mfcSupported: true },
    throughputClasses: ['rnd', 'small_batch'], automationLevels: ['manual', 'semi_automatic', 'recipe_controlled'], cleanroomSupport: ['not_required'],
  },
  {
    id: 'hybrid-magnetron-arc', name: 'Hybrid Magnetron + Arc',
    description: 'Гибридная платформа, совмещающая магнетронные и дуговые источники в одном процессе.',
    supportedPurposes: ['deposition', 'surface_treatment'], supportedTechnologies: ['magnetron_pvd', 'vacuum_arc_fcva', 'combined'],
    supportedSubstrateTypes: ['parts', 'tooling', 'custom_geometry'], maxChamberSizeMm: 300,
    supportedMaterialClasses: ['metals', 'nitrides', 'carbon_coatings'], maxProcessTempC: 500,
    pressureRange: { minMbar: 1e-5, maxMbar: 1e-1 },
    sources: { magnetronCount: 4, arcSourceCount: 2, icpRf: false, substrateBias: true, ionSource: true, combinedModeSupported: true },
    gasSystem: { maxGasLines: 5, mfcSupported: true },
    throughputClasses: ['small_batch', 'production'], automationLevels: ['semi_automatic', 'recipe_controlled', 'full_automatic'], cleanroomSupport: ['not_required', 'iso8'],
  },
  {
    id: 'pecvd-system', name: 'PECVD System',
    description: 'Система плазмохимического осаждения (PECVD/CVD) для диэлектрических и углеродных плёнок.',
    supportedPurposes: ['deposition'], supportedTechnologies: ['pecvd', 'cvd'],
    supportedSubstrateTypes: ['wafer', 'parts'], maxChamberSizeMm: 200,
    supportedMaterialClasses: ['dielectrics', 'carbon_coatings'], maxProcessTempC: 350,
    pressureRange: { minMbar: 1e-1, maxMbar: 10 },
    sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeSupported: false },
    gasSystem: { maxGasLines: 6, mfcSupported: true },
    throughputClasses: ['rnd', 'small_batch', 'production'], automationLevels: ['semi_automatic', 'recipe_controlled', 'full_automatic'], cleanroomSupport: ['iso8', 'iso7', 'iso6'],
  },
  {
    id: 'icp-rie-etcher', name: 'ICP/RIE Etcher',
    description: 'Плазменный травитель на базе ICP/RIE для микроэлектронных пластин.',
    supportedPurposes: ['etching'], supportedTechnologies: ['icp_rf_plasma'],
    supportedSubstrateTypes: ['wafer'], maxChamberSizeMm: 300,
    supportedMaterialClasses: ['metals', 'dielectrics', 'custom'], maxProcessTempC: 150,
    pressureRange: { minMbar: 1e-3, maxMbar: 1e-1 },
    sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeSupported: false },
    gasSystem: { maxGasLines: 8, mfcSupported: true },
    throughputClasses: ['small_batch', 'production'], automationLevels: ['recipe_controlled', 'full_automatic'], cleanroomSupport: ['iso7', 'iso6'],
  },
  {
    id: 'plasma-cleaning-system', name: 'Plasma Cleaning System',
    description: 'Установка плазменной очистки и активации поверхности перед последующими процессами.',
    supportedPurposes: ['plasma_cleaning', 'surface_treatment'], supportedTechnologies: ['icp_rf_plasma'],
    supportedSubstrateTypes: ['wafer', 'parts', 'tooling', 'custom_geometry'], maxChamberSizeMm: 400,
    supportedMaterialClasses: ['metals', 'dielectrics', 'custom'], maxProcessTempC: 200,
    pressureRange: { minMbar: 1e-2, maxMbar: 1 },
    sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: false, ionSource: false, combinedModeSupported: false },
    gasSystem: { maxGasLines: 2, mfcSupported: true },
    throughputClasses: ['rnd', 'small_batch', 'production'], automationLevels: ['manual', 'semi_automatic', 'recipe_controlled'], cleanroomSupport: ['not_required', 'iso8', 'iso7'],
  },
  {
    id: 'cluster-multi-process', name: 'Cluster / Multi-Process Platform',
    description: 'Кластерная платформа с несколькими модулями под разные процессы в одной системе.',
    supportedPurposes: ['deposition', 'etching', 'plasma_cleaning', 'surface_treatment'],
    supportedTechnologies: ['magnetron_pvd', 'vacuum_arc_fcva', 'pecvd', 'cvd', 'icp_rf_plasma', 'combined'],
    supportedSubstrateTypes: ['wafer', 'parts', 'tooling', 'custom_geometry'], maxChamberSizeMm: 300,
    supportedMaterialClasses: ['metals', 'nitrides', 'carbon_coatings', 'dielectrics', 'custom'], maxProcessTempC: 500,
    pressureRange: { minMbar: 1e-5, maxMbar: 10 },
    sources: { magnetronCount: 4, arcSourceCount: 2, icpRf: true, substrateBias: true, ionSource: true, combinedModeSupported: true },
    gasSystem: { maxGasLines: 8, mfcSupported: true },
    throughputClasses: ['rnd', 'small_batch', 'production'], automationLevels: ['manual', 'semi_automatic', 'recipe_controlled', 'full_automatic'], cleanroomSupport: ['not_required', 'iso8', 'iso7', 'iso6'],
  },
];

// ---------- hard filters (exclude outright, with a stated reason) ----------

export function hardFilterReasons(req: EquipmentRequirement, config: EquipmentConfiguration): string[] {
  const reasons: string[] = [];
  if (req.maxSizeMm > config.maxChamberSizeMm) {
    reasons.push(`Габарит изделия (${req.maxSizeMm} мм) превышает максимальный размер камеры конфигурации (${config.maxChamberSizeMm} мм).`);
  }
  if (req.sources.icpRf && !config.sources.icpRf) {
    reasons.push('Требуется источник ICP/RF, которого нет в данной конфигурации.');
  }
  if (req.gasSystem.gasLines > config.gasSystem.maxGasLines) {
    reasons.push(`Требуется ${req.gasSystem.gasLines} газовых линий, конфигурация поддерживает максимум ${config.gasSystem.maxGasLines}.`);
  }
  if (req.maxProcessTempC > config.maxProcessTempC) {
    reasons.push(`Требуемая температура процесса (${req.maxProcessTempC}°C) превышает максимально допустимую для конфигурации (${config.maxProcessTempC}°C).`);
  }
  if (!config.cleanroomSupport.includes(req.cleanroom)) {
    reasons.push(`Требуемый класс чистого помещения (${LABELS.cleanroom[req.cleanroom]}) не поддерживается данной конфигурацией.`);
  }
  if (req.pressureRange.minMbar < config.pressureRange.minMbar || req.pressureRange.maxMbar > config.pressureRange.maxMbar) {
    reasons.push(`Требуемый диапазон давления (${req.pressureRange.minMbar}…${req.pressureRange.maxMbar} мбар) выходит за пределы, поддерживаемые конфигурацией (${config.pressureRange.minMbar}…${config.pressureRange.maxMbar} мбар).`);
  }
  return reasons;
}

// ---------- weighted matching (all weights visible & testable) ----------

export const MATCH_WEIGHTS = {
  process: 20,
  substrate: 15,
  sources: 15,
  gas: 10,
  temperature: 10,
  automation: 10,
  throughput: 10,
  cleanroom: 10,
} as const;

export interface MatchBreakdown {
  process: number;
  substrate: number;
  sources: number;
  gas: number;
  temperature: number;
  automation: number;
  throughput: number;
  cleanroom: number;
}

function scoreProcess(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  const purposeOk = config.supportedPurposes.includes(req.purpose);
  const technologyOk = config.supportedTechnologies.includes(req.technology);
  const materialOk = config.supportedMaterialClasses.includes(req.materialClass);
  return ((purposeOk ? 1 : 0) + (technologyOk ? 1 : 0) + (materialOk ? 1 : 0)) / 3 * 100;
}

function scoreSubstrate(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  return config.supportedSubstrateTypes.includes(req.substrateType) ? 100 : 0;
}

function scoreSources(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  const checks: boolean[] = [];
  if (req.sources.magnetronCount > 0) checks.push(config.sources.magnetronCount >= req.sources.magnetronCount);
  if (req.sources.arcSourceCount > 0) checks.push(config.sources.arcSourceCount >= req.sources.arcSourceCount);
  if (req.sources.substrateBias) checks.push(config.sources.substrateBias);
  if (req.sources.ionSource) checks.push(config.sources.ionSource);
  if (req.sources.combinedModeRequired) checks.push(config.sources.combinedModeSupported);
  if (checks.length === 0) return 100;
  return checks.filter(Boolean).length / checks.length * 100;
}

function scoreGas(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  const mfcOk = !req.gasSystem.mfcRequired || config.gasSystem.mfcSupported;
  const capacityRatio = req.gasSystem.gasLines > 0 ? Math.min(100, (config.gasSystem.maxGasLines / req.gasSystem.gasLines) * 100) : 100;
  return (mfcOk ? 100 : 0) * 0.5 + capacityRatio * 0.5;
}

function scoreTemperature(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  // req.maxProcessTempC may legitimately be negative (validateRequirement allows -50..1500,
  // e.g. a cryo/cold plasma-cleaning requirement) - dividing by a negative number flips the
  // sign of the ratio, which previously produced scores like -1000% (Codex regression: a
  // valid negative required temperature broke the whole overall percentage). A score is
  // always a percentage match, so it must stay within [0, 100] regardless of the raw ratio.
  return Math.max(0, Math.min(100, (config.maxProcessTempC / req.maxProcessTempC) * 100));
}

function scoreAutomation(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  return config.automationLevels.includes(req.automation) ? 100 : 0;
}

function scoreThroughput(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  return config.throughputClasses.includes(req.throughputClass) ? 100 : 0;
}

function scoreCleanroom(req: EquipmentRequirement, config: EquipmentConfiguration): number {
  return config.cleanroomSupport.includes(req.cleanroom) ? 100 : 0;
}

export function computeBreakdown(req: EquipmentRequirement, config: EquipmentConfiguration): MatchBreakdown {
  return {
    process: scoreProcess(req, config),
    substrate: scoreSubstrate(req, config),
    sources: scoreSources(req, config),
    gas: scoreGas(req, config),
    temperature: scoreTemperature(req, config),
    automation: scoreAutomation(req, config),
    throughput: scoreThroughput(req, config),
    cleanroom: scoreCleanroom(req, config),
  };
}

export function computeOverallScore(breakdown: MatchBreakdown): number {
  const totalWeight = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted = (Object.keys(MATCH_WEIGHTS) as (keyof MatchBreakdown)[])
    .reduce((sum, key) => sum + breakdown[key] * MATCH_WEIGHTS[key], 0);
  return weighted / totalWeight;
}

export const RECOMMENDED_THRESHOLD = 85;

export type MatchStatus = 'recommended' | 'suitable_with_modifications' | 'not_suitable';

export interface MatchResult {
  config: EquipmentConfiguration;
  status: MatchStatus;
  overallScore: number | null;
  breakdown: MatchBreakdown | null;
  exclusionReasons: string[];
  whyItFits: string[];
  requiredModifications: string[];
}

const MODIFICATION_LABELS: Record<keyof MatchBreakdown, string> = {
  process: 'Требуется адаптация процесса, технологии или материала под задачу.',
  substrate: 'Требуется адаптация оснастки/держателя под тип подложки или изделия.',
  sources: 'Требуется дополнительный источник (магнетрон, arc, substrate bias или ion source).',
  gas: 'Требуется расширение газовой системы (доп. MFC/линии).',
  temperature: 'Требуется уточнение теплового режима у поставщика.',
  automation: 'Требуется другой уровень автоматизации или доработка системы управления.',
  throughput: 'Требуется уточнение класса производительности у поставщика.',
  cleanroom: 'Требуется адаптация под требования чистого помещения.',
};

const FIT_LABELS: Record<keyof MatchBreakdown, string> = {
  process: 'Назначение, технология и материал соответствуют требованию.',
  substrate: 'Тип подложки/изделия поддерживается.',
  sources: 'Требуемые источники плазмы/осаждения присутствуют.',
  gas: 'Газовая система удовлетворяет требованию.',
  temperature: 'Тепловой режим укладывается в допустимый диапазон.',
  automation: 'Уровень автоматизации соответствует требованию.',
  throughput: 'Класс производительности соответствует требованию.',
  cleanroom: 'Требования к чистому помещению выполняются.',
};

export function matchEquipment(req: EquipmentRequirement, catalog: EquipmentConfiguration[] = EQUIPMENT_CONFIGURATIONS): MatchResult[] {
  validateRequirement(req);

  const results: MatchResult[] = catalog.map(config => {
    const exclusionReasons = hardFilterReasons(req, config);
    if (exclusionReasons.length > 0) {
      return { config, status: 'not_suitable', overallScore: null, breakdown: null, exclusionReasons, whyItFits: [], requiredModifications: [] };
    }
    const breakdown = computeBreakdown(req, config);
    const overallScore = computeOverallScore(breakdown);
    const keys = Object.keys(breakdown) as (keyof MatchBreakdown)[];
    const whyItFits = keys.filter(key => breakdown[key] >= 100).map(key => FIT_LABELS[key]);
    const requiredModifications = keys.filter(key => breakdown[key] < 100).map(key => MODIFICATION_LABELS[key]);
    const status: MatchStatus = overallScore >= RECOMMENDED_THRESHOLD && requiredModifications.length === 0 ? 'recommended' : 'suitable_with_modifications';
    return { config, status, overallScore, breakdown, exclusionReasons: [], whyItFits, requiredModifications };
  });

  const statusRank: Record<MatchStatus, number> = { recommended: 0, suitable_with_modifications: 1, not_suitable: 2 };
  return results.sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    if ((b.overallScore ?? -1) !== (a.overallScore ?? -1)) return (b.overallScore ?? -1) - (a.overallScore ?? -1);
    return a.config.name.localeCompare(b.config.name);
  });
}

// ---------- comparison ----------

export interface ComparisonRow { parameter: string; values: string[] }

export function compareConfigurations(configIds: string[], catalog: EquipmentConfiguration[] = EQUIPMENT_CONFIGURATIONS): ComparisonRow[] {
  if (configIds.length < 2 || configIds.length > 3) throw new Error('Для сравнения выберите от 2 до 3 конфигураций.');
  const configs = configIds.map(id => {
    const found = catalog.find(c => c.id === id);
    if (!found) throw new Error(`Конфигурация не найдена: ${id}`);
    return found;
  });
  return [
    { parameter: 'Поддерживаемые процессы', values: configs.map(c => c.supportedPurposes.map(p => LABELS.purpose[p]).join(', ')) },
    { parameter: 'Источники', values: configs.map(c => [
      c.sources.magnetronCount > 0 ? `магнетроны: ${c.sources.magnetronCount}` : null,
      c.sources.arcSourceCount > 0 ? `arc: ${c.sources.arcSourceCount}` : null,
      c.sources.icpRf ? 'ICP/RF' : null,
      c.sources.substrateBias ? 'substrate bias' : null,
      c.sources.ionSource ? 'ion source' : null,
      c.sources.combinedModeSupported ? 'combined mode' : null,
    ].filter(Boolean).join(', ') || '—') },
    { parameter: 'Газовые линии (макс.)', values: configs.map(c => String(c.gasSystem.maxGasLines)) },
    { parameter: 'Максимальный размер изделия', values: configs.map(c => `${c.maxChamberSizeMm} мм`) },
    { parameter: 'Максимальная температура', values: configs.map(c => `${c.maxProcessTempC}°C`) },
    { parameter: 'Автоматизация', values: configs.map(c => c.automationLevels.map(a => LABELS.automation[a]).join(', ')) },
    { parameter: 'Класс производительности', values: configs.map(c => c.throughputClasses.map(t => LABELS.throughput[t]).join(', ')) },
    { parameter: 'Cleanroom', values: configs.map(c => c.cleanroomSupport.map(cl => LABELS.cleanroom[cl]).join(', ')) },
  ];
}

// ---------- handoff to Techno-Economic Assessment (technical parameters only, no invented cost) ----------

export interface TechnoEconomicHandoff {
  configurationId: string;
  configurationName: string;
  supportedPurposes: string[];
  supportedTechnologies: string[];
  maxChamberSizeMm: number;
  maxProcessTempC: number;
  sourcesSummary: string;
  maxGasLines: number;
  throughputClasses: string[];
  automationLevels: string[];
  cleanroomSupport: string[];
  note: string;
}

export function buildTechnoEconomicHandoff(config: EquipmentConfiguration): TechnoEconomicHandoff {
  const sourcesSummary = [
    config.sources.magnetronCount > 0 ? `${config.sources.magnetronCount} магнетрон(ов)` : null,
    config.sources.arcSourceCount > 0 ? `${config.sources.arcSourceCount} arc-источник(ов)` : null,
    config.sources.icpRf ? 'ICP/RF' : null,
    config.sources.substrateBias ? 'substrate bias' : null,
    config.sources.ionSource ? 'ion source' : null,
    config.sources.combinedModeSupported ? 'combined mode' : null,
  ].filter(Boolean).join(', ') || 'без дополнительных источников';

  return {
    configurationId: config.id,
    configurationName: config.name,
    supportedPurposes: config.supportedPurposes.map(p => LABELS.purpose[p]),
    supportedTechnologies: config.supportedTechnologies.map(t => LABELS.technology[t]),
    maxChamberSizeMm: config.maxChamberSizeMm,
    maxProcessTempC: config.maxProcessTempC,
    sourcesSummary,
    maxGasLines: config.gasSystem.maxGasLines,
    throughputClasses: config.throughputClasses.map(t => LABELS.throughput[t]),
    automationLevels: config.automationLevels.map(a => LABELS.automation[a]),
    cleanroomSupport: config.cleanroomSupport.map(c => LABELS.cleanroom[c]),
    note: 'Переданы только технические параметры конфигурации. Стоимость (CAPEX/OPEX) не рассчитывается автоматически — введите её вручную в Техно-экономической оценке.',
  };
}

// ---------- presets: fill the form only, no hidden magic ----------

export interface RequirementPreset { id: string; label: string; requirement: EquipmentRequirement }

export const REQUIREMENT_PRESETS: RequirementPreset[] = [
  {
    id: 'rnd-pvd-coatings', label: 'R&D PVD coatings',
    requirement: {
      purpose: 'deposition', technology: 'magnetron_pvd', substrateType: 'parts', maxSizeMm: 100,
      materialClass: 'metals', maxProcessTempC: 300, pressureRange: { minMbar: 1e-4, maxMbar: 1e-2 },
      sources: { magnetronCount: 1, arcSourceCount: 0, icpRf: false, substrateBias: true, ionSource: false, combinedModeRequired: false },
      gasSystem: { gasLines: 2, processGases: ['Ar', 'N2'], mfcRequired: true },
      throughputClass: 'rnd', automation: 'manual', cleanroom: 'not_required',
    },
  },
  {
    id: 'wear-resistant-tool-coatings', label: 'Wear-resistant tool coatings',
    requirement: {
      purpose: 'deposition', technology: 'vacuum_arc_fcva', substrateType: 'tooling', maxSizeMm: 150,
      materialClass: 'nitrides', maxProcessTempC: 450, pressureRange: { minMbar: 1e-4, maxMbar: 1e-2 },
      sources: { magnetronCount: 0, arcSourceCount: 2, icpRf: false, substrateBias: true, ionSource: false, combinedModeRequired: false },
      gasSystem: { gasLines: 2, processGases: ['Ar', 'N2'], mfcRequired: true },
      throughputClass: 'small_batch', automation: 'semi_automatic', cleanroom: 'not_required',
    },
  },
  {
    id: 'microelectronics-plasma-etching', label: 'Microelectronics plasma etching',
    requirement: {
      purpose: 'etching', technology: 'icp_rf_plasma', substrateType: 'wafer', maxSizeMm: 300,
      materialClass: 'dielectrics', maxProcessTempC: 150, pressureRange: { minMbar: 1e-3, maxMbar: 1e-2 },
      sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: true, ionSource: false, combinedModeRequired: false },
      gasSystem: { gasLines: 6, processGases: ['CF4', 'O2', 'Ar'], mfcRequired: true },
      throughputClass: 'production', automation: 'full_automatic', cleanroom: 'iso6',
    },
  },
  {
    id: 'plasma-cleaning', label: 'Plasma cleaning',
    requirement: {
      purpose: 'plasma_cleaning', technology: 'icp_rf_plasma', substrateType: 'custom_geometry', maxSizeMm: 200,
      materialClass: 'custom', maxProcessTempC: 150, pressureRange: { minMbar: 1e-2, maxMbar: 5e-1 },
      sources: { magnetronCount: 0, arcSourceCount: 0, icpRf: true, substrateBias: false, ionSource: false, combinedModeRequired: false },
      gasSystem: { gasLines: 2, processGases: ['O2', 'Ar'], mfcRequired: true },
      throughputClass: 'small_batch', automation: 'semi_automatic', cleanroom: 'iso8',
    },
  },
  {
    id: 'hybrid-pvd-arc-rnd', label: 'Hybrid PVD/arc R&D',
    requirement: {
      purpose: 'deposition', technology: 'combined', substrateType: 'parts', maxSizeMm: 150,
      materialClass: 'carbon_coatings', maxProcessTempC: 400, pressureRange: { minMbar: 1e-4, maxMbar: 1e-2 },
      sources: { magnetronCount: 2, arcSourceCount: 1, icpRf: false, substrateBias: true, ionSource: false, combinedModeRequired: true },
      gasSystem: { gasLines: 4, processGases: ['Ar', 'C2H2'], mfcRequired: true },
      throughputClass: 'rnd', automation: 'semi_automatic', cleanroom: 'not_required',
    },
  },
];
