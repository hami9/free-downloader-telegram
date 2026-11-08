import { table, integer, text } from 'sdk/db';

export const cachedMedia = table('cached_media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  formatId: text('format_id').default(''),
  fileId: text('file_id').notNull(),
  mediaType: text('media_type').notNull(), // 'video' | 'audio'
  caption: text('caption'),
  createdAt: integer('created_at').notNull(),
});
