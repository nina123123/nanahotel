// Guest-name checks shared by bookings (and usable by profile validation). Mainland hotels check every
// guest's ID against the booking, so honorifics and stand-in words are not usable names.

export const NAME_RE = /^[\p{L}\p{M}·•.'\- ]{2,20}$/u;

const HONORIFIC_SUFFIX = /(先生|女士|小姐|太太|夫人)$/u;
const HONORIFIC_PREFIX = /^(mr|mrs|ms|miss|dr)\.?(\s|$)/i;
const PLACEHOLDER_RE = /^(test|guest|user|name)(\s|$)|^测试|某/i;
const PLACEHOLDERS = new Set([
  '本人', '我', '我自己', '自己', '客人', '用户', '住客', '入住人', '姓名', '名字', '游客', '旅客', '匿名', '无',
  '朋友', '同事', '家人', '老婆', '老公', '爸爸', '妈妈', '孩子', '儿子', '女儿',
]);

/** 'format' (not 2–20 letters), 'placeholder' ('张先生', '本人', 'test'), or null when usable. */
export function guestNameProblem(name) {
  const s = String(name ?? '').trim();
  if (!NAME_RE.test(s)) return 'format';
  if (PLACEHOLDERS.has(s) || HONORIFIC_SUFFIX.test(s) || HONORIFIC_PREFIX.test(s) || PLACEHOLDER_RE.test(s)) return 'placeholder';
  return null;
}

export function isValidGuestName(name) {
  return guestNameProblem(name) === null;
}
