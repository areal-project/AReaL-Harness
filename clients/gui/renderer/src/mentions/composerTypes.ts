import type { MentionCategory, MentionItemData } from "./mentionTypes.js";
export interface ComposerMentionPrefill { id:string; category:MentionCategory; label:string; value:string; markdown:string; description?:string; data?:MentionItemData; }
