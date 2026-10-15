import { fr as common } from './common';
import { fr as corporate } from './corporate';
import { fr as distributor } from './distributor';
import { fr as employee } from './employee';
import { fr as station } from './station';

// Shared words (common) win over a screen's own choice, so a term reads the same everywhere.
export const FR: Record<string, string> = { ...distributor, ...corporate, ...station, ...employee, ...common };
