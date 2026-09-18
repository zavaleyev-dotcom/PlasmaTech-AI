/** Browser-safe constants/types shared between the TechDoc Assistant client UI and the
 *  server-only export renderer (techdoc-export.ts). Deliberately has NO import of `docx`,
 *  `pdfkit`, or any font asset - those are Node-only and must never reach the client bundle;
 *  the UI only needs to know the four document types, the two formats, and their labels. */

export const DOCUMENT_TYPES = ['instruction', 'technologicalCard', 'routeCard', 'recipe'] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export const EXPORT_FORMATS = ['docx', 'pdf'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  instruction: 'Технологическая инструкция',
  technologicalCard: 'Технологическая карта',
  routeCard: 'Маршрутная карта',
  recipe: 'Краткий рецепт',
};

export const FILENAME_SEGMENT: Record<DocumentType, string> = {
  instruction: 'instruction',
  technologicalCard: 'technology-card',
  routeCard: 'route-card',
  recipe: 'recipe',
};
