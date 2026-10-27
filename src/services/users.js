import { ROLE_LABELS, ROLES } from '../domain.js';

/**
 * Resolucion de identidad: Telegram ID / email -> usuario de la familia.
 * Reglas:
 *  - Si FAMILY_MEMBERS esta configurado, solo esos IDs/emails pueden operar.
 *  - Si no hay miembros configurados, se auto-registra el usuario (modo abierto).
 *  - Un usuario desactivado no puede operar.
 */
export function createUsersService({ repos, config, logger }) {
  async function syncFamilyMembers() {
    const synced = [];
    for (const member of config.family.members) {
      try {
        const user = await repos.users.upsertFromConfig(member);
        synced.push(user);
      } catch (error) {
        logger?.error?.('no se pudo sincronizar miembro familiar', {
          member: member.name,
          error,
        });
      }
    }
    if (synced.length) logger?.info?.('miembros familiares sincronizados', { count: synced.length });
    return synced;
  }

  async function resolveTelegramUser({ telegramId, firstName, username, chatId } = {}) {
    const normalizedId = telegramId === null || telegramId === undefined ? '' : String(telegramId).replace(/[^\d-]/g, '');
    if (!normalizedId) {
      return { ok: false, reason: 'missing-telegram-id', message: 'No pude identificar tu usuario de Telegram.' };
    }

    const existing = await repos.users.getByTelegramId(normalizedId);
    if (existing) {
      if (!existing.active) {
        return {
          ok: false,
          reason: 'inactive-user',
          user: existing,
          message: 'Tu usuario esta desactivado. Pedile al administrador que lo reactive.',
        };
      }
      return { ok: true, user: existing, isNew: false };
    }

    const configured = config.family.members.find((member) => member.telegramId === normalizedId);
    if (configured) {
      const user = await repos.users.upsertFromConfig(configured);
      return { ok: true, user, isNew: true };
    }

    if (config.family.members.length === 0) {
      const name = (firstName || username || 'Familiar').toString().slice(0, 80);
      const user = await repos.users.create({
        name,
        role: ROLES.OTHER,
        telegramId: normalizedId,
      });
      logger?.info?.('usuario auto-registrado', { userId: user.id, telegramId: normalizedId });
      return { ok: true, user, isNew: true };
    }

    const allowedChat = (config.telegram.allowedChatIds || []).includes(String(chatId || ''));
    return {
      ok: false,
      reason: allowedChat ? 'not-a-member' : 'unknown-chat',
      telegramId: normalizedId,
      message: [
        '🚫 No tengo permiso para registrar movimientos de este usuario.',
        '',
        `Tu Telegram ID es: <code>${normalizedId}</code>`,
        'Pedile al administrador que lo agregue en FAMILY_MEMBERS y reinicie el bot.',
      ].join('\n'),
    };
  }

  async function resolveEmailUser(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    let user = await repos.users.getByEmail(normalized);
    if (!user) {
      const configured = config.family.members.find((member) => member.email === normalized);
      if (configured) user = await repos.users.upsertFromConfig(configured);
    }
    if (user && !user.active) return null;
    return user;
  }

  async function getById(id) {
    return repos.users.get(id);
  }

  async function listActive() {
    return repos.users.list({ includeInactive: false });
  }

  function userLabel(user) {
    if (!user) return 'Sin asignar';
    const role = ROLE_LABELS[user.role];
    return role && role !== 'Familiar' ? `${user.name} (${role})` : user.name;
  }

  return {
    syncFamilyMembers,
    resolveTelegramUser,
    resolveEmailUser,
    getById,
    listActive,
    userLabel,
  };
}
