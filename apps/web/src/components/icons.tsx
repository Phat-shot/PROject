/**
 * Icon-Set (Lucide, 16 px, Strich 2): ein Ort für alle Symbole statt Emoji. Jedes Icon ist dekorativ (aria-hidden);
 * die Bedeutung trägt der Knopf (aria-label) oder der sichtbare Text daneben.
 */
import type { ComponentType, SVGProps } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpRight, Cloud, Copy, Archive, CornerLeftUp, Download, FileText, Folder, Bell, Check, CheckSquare, ChevronDown, ChevronRight, ChevronUp, Circle, Clock, CornerDownLeft,
  Diamond, Hourglass, Link2, Lock, LockOpen, Mail, Menu, MessageSquare, MoreHorizontal, Paperclip, Pencil, Plus, RotateCw, Scissors, Search, Settings, Star,
  ThumbsDown, ThumbsUp, Trash2, X
} from 'lucide-react';

type Props = SVGProps<SVGSVGElement> & { size?: number };
const wrap = (C: ComponentType<any>) => function Icon({ size = 16, className = '', ...rest }: Props) {
  return <C size={size} className={`icon ${className}`.trim()} aria-hidden="true" focusable="false" {...rest} />;
};

export const IconX = wrap(X);
export const IconCheck = wrap(Check);
export const IconCheckSquare = wrap(CheckSquare);
export const IconChevronDown = wrap(ChevronDown);
export const IconChevronRight = wrap(ChevronRight);
export const IconChevronUp = wrap(ChevronUp);
export const IconLock = wrap(Lock);
export const IconLockOpen = wrap(LockOpen);
export const IconStar = wrap(Star);
export const IconMenu = wrap(Menu);
export const IconClock = wrap(Clock);
export const IconHourglass = wrap(Hourglass);
export const IconAlert = wrap(AlertTriangle);
export const IconComment = wrap(MessageSquare);
export const IconSettings = wrap(Settings);
export const IconArrowLeft = wrap(ArrowLeft);
export const IconArrowRight = wrap(ArrowRight);
export const IconArrowUpRight = wrap(ArrowUpRight);
export const IconArrowUp = wrap(ArrowUp);
export const IconArrowDown = wrap(ArrowDown);
export const IconCopy = wrap(Copy);
export const IconPaperclip = wrap(Paperclip);
export const IconDiamond = wrap(Diamond);
export const IconRotate = wrap(RotateCw);
export const IconMore = wrap(MoreHorizontal);
export const IconThumbsUp = wrap(ThumbsUp);
export const IconThumbsDown = wrap(ThumbsDown);
export const IconPencil = wrap(Pencil);
export const IconMail = wrap(Mail);
export const IconTrash = wrap(Trash2);
export const IconPlus = wrap(Plus);
export const IconSearch = wrap(Search);
export const IconBell = wrap(Bell);
export const IconLink = wrap(Link2);
export const IconArchive = wrap(Archive);
export const IconReply = wrap(CornerDownLeft);
export const IconScissors = wrap(Scissors);
export const IconCircle = wrap(Circle);
export const IconCloud = wrap(Cloud);
export const IconFolder = wrap(Folder);
export const IconFile = wrap(FileText);
export const IconDownload = wrap(Download);
export const IconUp = wrap(CornerLeftUp);
