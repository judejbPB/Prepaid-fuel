import { fr as accounting } from './accounting';
import { fr as alerts } from './alerts';
import { fr as assistant } from './assistant';
import { fr as audit } from './audit';
import { fr as reports } from './reports';
import { fr as common } from './common';
import { fr as corporate } from './corporate';
import { fr as distributor } from './distributor';
import { fr as employee } from './employee';
import { fr as station } from './station';

// Shared words (common) win over a screen's own choice, so a term reads the same everywhere.
export const FR: Record<string, string> = { ...accounting, ...alerts, ...assistant, ...reports, ...audit, ...distributor, ...corporate, ...station, ...employee, ...common };
