import { sqliteTable, text, integer } from 'sdk/db';

// Table to cache downloaded file_ids directly inside Telegram's SQLite database
export const cachedMedia = sqliteTable('cached_media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  formatId: text('format_id').default(''),
  fileId: text('file_id').notNull(),
  mediaType: text('media_type').notNull(), // 'video' | 'audio'
  caption: text('caption'),
  createdAt: integer('created_at').notNull(),
});

// Table to track active requests per user
export const userDownloads = sqliteTable('user_downloads', {
  userId: integer('user_id').primaryKey(),
  isBusy: integer('is_busy').default(0),
  lastActive: integer('last_active').notNull(),
});
