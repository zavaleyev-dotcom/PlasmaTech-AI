/** The definitions of the properties M1.3.2 can hold values of. DEFINITIONS ONLY - no numerical values of any material. Every property is expressed in a kind that
 *  the physics registry already has (M1.3.0); nothing was added to `src/physics/` and no similar-looking kind was substituted. Frozen. */

import { deepFreeze, QUANTITY_KINDS, type QuantityKind } from '@/physics';
import type { ConditionKey, PropertyDefinition } from './property-types';

type Base = Omit<PropertyDefinition, 'dimension' | 'siUnit' | 'valueForms'> & { kind: QuantityKind };

const COMMON: readonly ConditionKey[] = ['temperature', 'temperatureRange', 'pressure', 'atmosphere', 'materialState', 'measurementMethod', 'thickness', 'context'];
const withDirection: readonly ConditionKey[] = [...COMMON, 'direction'];
const FILM_TRANSPORT: readonly ConditionKey[] = ['thickness', 'direction'];

function define(base: Base): PropertyDefinition {
  const spec = QUANTITY_KINDS[base.kind];
  return { ...base, siUnit: spec.siUnit as PropertyDefinition['siUnit'], dimension: spec.dimension, valueForms: ['scalar'] };
}

const DEFINITION_LIST: readonly PropertyDefinition[] = [
  define({ id: 'density', nameRu: 'массовая плотность', nameEn: 'mass density', kind: 'massDensity', definitionRu: 'Масса единицы объёма материала при указанных условиях.', requiredConditions: ['temperature'], allowedConditions: COMMON }),
  define({ id: 'thermal_conductivity', nameRu: 'теплопроводность', nameEn: 'thermal conductivity', kind: 'thermalConductivity', definitionRu: 'Коэффициент пропорциональности между плотностью теплового потока и градиентом температуры (скаляр: главное значение вдоль указанного направления).', requiredConditions: ['temperature'], allowedConditions: withDirection, filmRequiredConditions: FILM_TRANSPORT }),
  define({ id: 'specific_heat_capacity', nameRu: 'удельная теплоёмкость', nameEn: 'specific heat capacity', kind: 'specificHeatCapacity', definitionRu: 'Теплота, необходимая для нагрева единицы массы на единицу температуры при указанном режиме (при постоянном давлении или при постоянном объёме).', requiredConditions: ['temperature', 'heatCapacityMode'], allowedConditions: [...COMMON, 'heatCapacityMode'] }),
  define({
    id: 'linear_expansion_coefficient', nameRu: 'коэффициент линейного теплового расширения', nameEn: 'coefficient of linear thermal expansion', kind: 'linearExpansionCoefficient',
    definitionRu: 'Относительное изменение длины на единицу изменения температуры. Касательный коэффициент — производная (1/L)·dL/dT при температуре T; средний — отношение изменения длины к интервалу температур между опорной температурой T₀ и T. Это разные числа, определение обязательно указывается.',
    requiredConditions: ['expansionDefinition'], allowedConditions: [...withDirection, 'referenceTemperature', 'expansionDefinition'],
    conditionalRules: [
      { when: { key: 'expansionDefinition', equals: 'tangent' }, require: ['temperature'], forbid: ['referenceTemperature', 'temperatureRange'] },
      { when: { key: 'expansionDefinition', equals: 'mean' }, require: ['temperature', 'referenceTemperature'], forbid: ['temperatureRange'] },
    ],
  }),
  define({ id: 'electrical_resistivity', nameRu: 'удельное электрическое сопротивление', nameEn: 'electrical resistivity', kind: 'resistivity', definitionRu: 'Сопротивление проводника единичной длины и единичного сечения вдоль указанного направления.', requiredConditions: ['temperature'], allowedConditions: withDirection, filmRequiredConditions: FILM_TRANSPORT }),
  define({ id: 'electrical_conductivity', nameRu: 'удельная электрическая проводимость', nameEn: 'electrical conductivity', kind: 'electricalConductivity', definitionRu: 'Величина, обратная удельному электрическому сопротивлению, вдоль указанного направления.', requiredConditions: ['temperature'], allowedConditions: withDirection, filmRequiredConditions: FILM_TRANSPORT }),
  define({ id: 'molar_mass', nameRu: 'молярная масса', nameEn: 'molar mass', kind: 'molarMass', definitionRu: 'Масса одного моля вещества указанного состава.', requiredConditions: [], allowedConditions: ['context'] }),
  define({ id: 'youngs_modulus', nameRu: 'модуль Юнга', nameEn: "Young's modulus", kind: 'elasticModulus', definitionRu: 'Отношение нормального напряжения к относительной деформации при одноосном нагружении в упругой области вдоль указанного направления.', requiredConditions: ['temperature'], allowedConditions: withDirection }),
  define({ id: 'shear_modulus', nameRu: 'модуль сдвига', nameEn: 'shear modulus', kind: 'elasticModulus', definitionRu: 'Отношение касательного напряжения к углу сдвига в упругой области.', requiredConditions: ['temperature'], allowedConditions: withDirection }),
  define({ id: 'bulk_modulus', nameRu: 'объёмный модуль', nameEn: 'bulk modulus', kind: 'elasticModulus', definitionRu: 'Отношение гидростатического давления к относительному изменению объёма в упругой области.', requiredConditions: ['temperature'], allowedConditions: COMMON }),
  define({ id: 'thermal_diffusivity', nameRu: 'коэффициент температуропроводности', nameEn: 'thermal diffusivity', kind: 'thermalDiffusivity', definitionRu: 'Отношение теплопроводности к произведению плотности и удельной теплоёмкости; скорость выравнивания температуры.', requiredConditions: ['temperature'], allowedConditions: withDirection, filmRequiredConditions: FILM_TRANSPORT }),
];

export const PROPERTY_DEFINITIONS: readonly PropertyDefinition[] = deepFreeze(DEFINITION_LIST);

const BY_ID: ReadonlyMap<string, PropertyDefinition> = new Map(PROPERTY_DEFINITIONS.map(d => [d.id, d]));

/** The definition with this id, or `undefined` (never a prototype property, never a guess). */
export const getPropertyDefinition = (id: unknown): PropertyDefinition | undefined => (typeof id === 'string' ? BY_ID.get(id) : undefined);
