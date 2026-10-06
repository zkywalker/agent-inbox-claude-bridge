export interface Sticker {
  id: string;
  packId: string;
  name: string;
  emoji: string;
  tags: string[];
  file?: string;
  creatorAgentId?: string;
  attachmentId?: string;
  width?: number;
  height?: number;
}

export interface StickerPack {
  id: string;
  name: string;
  source: 'telegram' | 'agent';
  creatorAgentId?: string;
  setName?: string;
  sourceUrl?: string;
  description?: string;
}

export interface StickerMessageContent {
  id?: string;
  name?: string;
  emoji?: string;
  packName?: string;
  attachmentId?: string;
  width?: number;
  height?: number;
}

export interface StickerCatalogue {
  packs: StickerPack[];
  stickers: Sticker[];
  total: number;
  nextOffset: number | null;
}

export const MAX_STICKER_BYTES = 8 * 1024 * 1024;

export const stickerPacks: StickerPack[] = [
  { id: 'telegram-animals-v1', name: 'Animals', source: 'telegram', setName: 'Animals', sourceUrl: 'https://t.me/addstickers/Animals', description: 'Telegram 动物表情精选，适合轻松吐槽和回应。' },
  { id: 'telegram-sugar-v1', name: 'Sugar Cubs', source: 'telegram', setName: 'facebooksugarcubs', sourceUrl: 'https://t.me/addstickers/facebooksugarcubs', description: 'Telegram 小熊表情精选，适合问候、安慰和陪伴。' },
];

export const stickers: Sticker[] = [
  { id: 'telegram-animals-v1/doge', packId: 'telegram-animals-v1', name: '斜眼笑', emoji: '😏', tags: ['调皮', '玩笑', 'doge', 'playful'], file: 'animals/1.webp' },
  { id: 'telegram-animals-v1/grumpy', packId: 'telegram-animals-v1', name: '不开心', emoji: '😒', tags: ['无语', '不开心', 'grumpy'], file: 'animals/2.webp' },
  { id: 'telegram-animals-v1/proud', packId: 'telegram-animals-v1', name: '得意', emoji: '😎', tags: ['得意', '自信', 'proud'], file: 'animals/3.webp' },
  { id: 'telegram-animals-v1/watching', packId: 'telegram-animals-v1', name: '盯住', emoji: '👀', tags: ['关注', '围观', 'watching'], file: 'animals/4.webp' },
  { id: 'telegram-animals-v1/snack', packId: 'telegram-animals-v1', name: '吃瓜', emoji: '🌿', tags: ['吃瓜', '休息', 'snack'], file: 'animals/5.webp' },
  { id: 'telegram-animals-v1/happy', packId: 'telegram-animals-v1', name: '开心', emoji: '😄', tags: ['开心', '快乐', 'happy'], file: 'animals/6.webp' },
  { id: 'telegram-sugar-v1/comfort', packId: 'telegram-sugar-v1', name: '安慰', emoji: '🥺', tags: ['安慰', '关心', 'comfort'], file: 'sugar/1.webp' },
  { id: 'telegram-sugar-v1/flower', packId: 'telegram-sugar-v1', name: '送花', emoji: '🌹', tags: ['感谢', '送花', 'thanks', 'flower'], file: 'sugar/2.webp' },
  { id: 'telegram-sugar-v1/shy', packId: 'telegram-sugar-v1', name: '害羞', emoji: '☺️', tags: ['害羞', '喜欢', 'shy'], file: 'sugar/3.webp' },
  { id: 'telegram-sugar-v1/morning', packId: 'telegram-sugar-v1', name: '早安', emoji: '☀️', tags: ['早安', '问候', 'morning', 'hello'], file: 'sugar/4.webp' },
  { id: 'telegram-sugar-v1/company', packId: 'telegram-sugar-v1', name: '陪伴', emoji: '💛', tags: ['陪伴', '温暖', 'company'], file: 'sugar/5.webp' },
  { id: 'telegram-sugar-v1/hug', packId: 'telegram-sugar-v1', name: '抱抱', emoji: '🤗', tags: ['抱抱', '鼓励', 'hug', 'cheer'], file: 'sugar/6.webp' },
];

export const findSticker = (id: string) => stickers.find(sticker => sticker.id === id);
export const stickerFallback = (sticker: Sticker) => `[贴纸：${sticker.name}]`;
export const stickerUrl = (id: string) => `/api/stickers/${encodeURIComponent(id)}/content`;
