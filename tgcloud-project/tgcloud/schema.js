import { index, integer, table, text, uniqueIndex } from 'sdk/db';

export const cachedMedia = table(
  'cached_media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    url: text('url').notNull(),
    formatId: text('format_id').default(''),
    fileId: text('file_id').notNull(),
    mediaType: text('media_type').notNull(), // 'video' | 'audio' | 'photo' | 'album' | 'document' | 'ref' | 'setting'
    caption: text('caption'),
    createdAt: integer('created_at').notNull(),
  },
  t => ({
    urlFormatUq: uniqueIndex('uq_cached_url_fmt').on(t.url, t.formatId),
    typeCreatedIdx: index('idx_cached_type_created').on(t.mediaType, t.createdAt),
    createdIdx: index('idx_cached_created').on(t.createdAt),
  })
);

export const activeDownloads = table(
  'active_downloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    token: text('token').notNull(),
    cancelled: integer('cancelled').default(0),
    createdAt: integer('created_at').notNull(),
  },
  t => ({
    chatTokenUq: uniqueIndex('uq_active_chat_token').on(t.chatId, t.token),
    createdIdx: index('idx_active_created').on(t.createdAt),
  })
);
