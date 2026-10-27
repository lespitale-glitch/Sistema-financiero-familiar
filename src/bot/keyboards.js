/**
 * Teclados inline compartidos por el bot y la ingesta de email.
 * callback_data maxima: 64 bytes.
 */

export const DOCUMENT_ACTIONS = Object.freeze({
  CONFIRM: 'confirm',
  EDIT: 'edit',
  CANCEL: 'cancel',
  CATEGORY: 'cat',
});

export const DOCUMENT_CALLBACK_PREFIX = 'doc';

export function documentKeyboard(documentId) {
  const id = String(documentId || '');
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirmar', callback_data: `${DOCUMENT_CALLBACK_PREFIX}:${DOCUMENT_ACTIONS.CONFIRM}:${id}` },
        { text: '✏️ Corregir', callback_data: `${DOCUMENT_CALLBACK_PREFIX}:${DOCUMENT_ACTIONS.EDIT}:${id}` },
      ],
      [
        { text: '❌ Descartar', callback_data: `${DOCUMENT_CALLBACK_PREFIX}:${DOCUMENT_ACTIONS.CANCEL}:${id}` },
      ],
    ],
  };
}

export function categoriesKeyboard(categories, { prefix = `${DOCUMENT_CALLBACK_PREFIX}:${DOCUMENT_ACTIONS.CATEGORY}`, columns = 2 } = {}) {
  const buttons = (categories || []).map((category) => ({
    text: `${category.emoji || '🏷️'} ${category.name}`.slice(0, 60),
    callback_data: `${prefix}:${category.id}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += columns) {
    rows.push(buttons.slice(index, index + columns));
  }
  return { inline_keyboard: rows };
}

/**
 * Parsea callback_data de documentos.
 * Formatos:
 *  - doc:confirm:<documentId>
 *  - doc:edit:<documentId>
 *  - doc:cancel:<documentId>
 *  - doc:cat:<documentId>:<categoryId>
 */
export function parseDocumentCallback(data) {
  const parts = String(data || '').split(':');
  if (parts[0] !== DOCUMENT_CALLBACK_PREFIX) return null;
  const action = parts[1];
  if (!Object.values(DOCUMENT_ACTIONS).includes(action)) return null;
  if (action === DOCUMENT_ACTIONS.CATEGORY) {
    const [, , documentId, categoryId] = parts;
    if (!documentId || !categoryId) return null;
    return { action, documentId, categoryId };
  }
  const documentId = parts[2];
  if (!documentId) return null;
  return { action, documentId };
}
