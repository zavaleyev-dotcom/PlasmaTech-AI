/** Materials registry, M1.3.1: identity, composition, phase, structure, form and layer stacks of materials - WHAT a material is, with validators. No property values
 *  (those are M1.3.2, with sources). No data files, no interface, no export. See README.md. */
export * from './errors';
export * from './elements';
export * from './ids';
export * from './types';
export { validateComposition, atomicFractionsFromStoichiometry, COMPOSITION_TYPES_BY_KIND } from './composition';
export { validatePhase, validateStructure, stableRangeKelvin } from './phase';
export { validateForm, checkStateForm, STATE_FORM_COMPATIBILITY, type StateFormVerdict } from './form';
export { validateStack, flattenStack, totalThickness, MAX_STACK_DEPTH, MAX_FLAT_LAYERS, type FlatLayer } from './stack';
export { validateIdentity, validateVariant, describeMissingData, createIdentity, createVariant, type MissingDatum } from './variant';
export { validateCatalog, createCatalog, referencedVariantIds, variantReferences, type ReferenceRole, type VariantReference } from './catalog';
export * from './property-types';
export { PROPERTY_DEFINITIONS, getPropertyDefinition } from './property-definitions';
export { collectConditions } from './conditions';
export { collectUncertainty } from './property-uncertainty';
export { collectProvenance, isValidIsbn, MIN_SOURCE_YEAR, MAX_SOURCE_YEAR } from './provenance';
export { validatePropertyRecord, validatePropertyRecords, createPropertyRecord, propertyDefinitionOf } from './property-record';
export { propertyToMeasured, propertyNominal, type NominalValue } from './property-use';
export * from './registry-types';
export { createMaterialPropertyRegistry } from './registry';
export { compareRecords, describeDifferences, type RecordComparison } from './registry-differences';
export { collectQuery, normalizedIdentifier } from './registry-query';
export * from './series-types';
export { validatePropertySeries, validatePropertySeriesSet, createPropertySeries } from './series';
export { collectCorrelation, collectApplicability } from './series-parts';
