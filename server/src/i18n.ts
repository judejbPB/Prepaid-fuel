/**
 * Response-time translation of user-facing API text.
 *
 * Messages stay in English in the code (and in the database); the error handler and a serialization hook
 * translate them for the language the client asks for with the `x-lang` header. French is the default:
 * only `x-lang: en` gets English. Unknown messages fall back to the English text.
 */

export type Lang = 'fr' | 'en';

type Headers = Record<string, string | string[] | undefined>;

export function requestLang(headers: Headers | undefined): Lang {
  const raw = headers?.['x-lang'];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return v === 'en' ? 'en' : 'fr';
}

// ----------------------------------------------------------------------------- vocabulary

type Gender = 'm' | 'f';

/** Status codes as French adjectives, [masculine, feminine]. */
const STATUS: Record<string, [string, string]> = {
  draft: ['à l’état de brouillon', 'à l’état de brouillon'],
  pending_approval: ['en attente d’approbation', 'en attente d’approbation'],
  posted: ['comptabilisé', 'comptabilisée'],
  rejected: ['rejeté', 'rejetée'],
  approved: ['approuvé', 'approuvée'],
  requested: ['demandé', 'demandée'],
  paid: ['payé', 'payée'],
  awaiting_bank: ['en attente du virement bancaire', 'en attente du virement bancaire'],
  matched: ['rapproché', 'rapprochée'],
  unmatched: ['non rapproché', 'non rapprochée'],
  ignored: ['ignoré', 'ignorée'],
  active: ['actif', 'active'],
  frozen: ['gelé', 'gelée'],
  inactive: ['inactif', 'inactive'],
  disabled: ['désactivé', 'désactivée'],
  retired: ['retiré', 'retirée'],
  expired: ['expiré', 'expirée'],
  revoked: ['révoqué', 'révoquée'],
  pending: ['en attente', 'en attente'],
  completed: ['terminé', 'terminée'],
  cancelled: ['annulé', 'annulée'],
  open: ['ouvert', 'ouverte'],
  proposed: ['proposé', 'proposée'],
  resolved: ['résolu', 'résolue'],
  ready: ['prêt', 'prête'],
  held: ['retenu', 'retenue'],
  closed: ['fermé', 'fermée'],
  accepted: ['accepté', 'acceptée'],
  paused: ['suspendu', 'suspendue'],
};
const status = (s: string, g: Gender) => STATUS[s]?.[g === 'm' ? 0 : 1] ?? s;

/** Fuel grades with their French article. */
const GRADE: Record<string, string> = { diesel: 'le diesel', gasoline: 'la gazoline' };
const gradeWithArticle = (g: string) => GRADE[g] ?? g;
const gradeName = (g: string) => (g === 'gasoline' ? 'gazoline' : g);

const ROLE: Record<string, string> = {
  dist_admin: 'administrateur du distributeur',
  dist_treasury: 'trésorerie du distributeur',
  dist_approver: 'approbateur du distributeur',
  co_preparer: 'préparateur de l’entreprise',
  co_approver: 'approbateur de l’entreprise',
  st_manager: 'gérant de station-service',
  st_attendant: 'pompiste',
  employee: 'employé',
};

/** Things that can be "not found" (see errors.notFound). */
const NOUN: Record<string, string> = {
  Refund: 'Remboursement',
  Lot: 'Lot',
  'Allocation batch': 'Lot d’allocation',
  'Allocation line': 'Ligne d’allocation',
  'Recurring allocation': 'Allocation récurrente',
  'Activation code': 'Code d’activation',
  Employee: 'Employé',
  'Bank line': 'Ligne bancaire',
  Redemption: 'Transaction de carburant',
  Exception: 'Exception',
  Company: 'Entreprise',
  'Funding request': 'Demande de financement',
  company: 'Entreprise',
  employee: 'Employé',
  station: 'Station-service',
  terminal: 'Terminal',
  lot: 'Lot',
};

/** Subjects of "<X> is <status>" messages: [French subject with article, gender]. */
const SUBJECT: Record<string, [string, Gender]> = {
  Refund: ['Le remboursement', 'm'],
  Batch: ['Le lot d’allocation', 'm'],
  Funding: ['Le financement', 'm'],
  'Bank line': ['La ligne bancaire', 'f'],
  Request: ['La demande', 'f'],
  'This request': ['Cette demande', 'f'],
  Exception: ['L’exception', 'f'],
  company: ['L’entreprise', 'f'],
  employee: ['L’employé', 'm'],
  station: ['La station-service', 'f'],
  terminal: ['Le terminal', 'm'],
  lot: ['Le lot', 'm'],
};

// ----------------------------------------------------------------------------- error messages

const EXACT: Record<string, string> = {
  // errors.ts defaults, app.ts
  'Not allowed': 'Action non autorisée',
  'A record with these details already exists': 'Un enregistrement avec ces informations existe déjà',
  'Unexpected error': 'Erreur inattendue. Veuillez réessayer.',
  'No such endpoint': 'Ressource introuvable',
  'The demo server was busy and nothing was saved. Please try again.':
    'Le serveur de démonstration était occupé et rien n’a été enregistré. Veuillez réessayer.',

  // auth.ts
  'Other company data is not accessible': 'Les données d’une autre entreprise ne sont pas accessibles',
  'Invalid login or password': 'Identifiant ou mot de passe invalide',
  'This device is not a registered terminal. Activate it with your station’s code, then sign in.':
    'Cet appareil n’est pas un terminal enregistré. Activez-le avec le code de votre station-service, puis connectez-vous.',
  'This terminal is frozen': 'Ce terminal est gelé',
  'No employee profile': 'Aucun profil d’employé',
  'Device id required': 'Identifiant de l’appareil requis',
  'This account is bound to another phone. Ask your company admin for recovery.':
    'Ce compte est associé à un autre téléphone. Demandez une récupération à l’administrateur de votre entreprise.',
  'Sign in required': 'Veuillez vous connecter',
  'Session expired': 'Session expirée. Veuillez vous reconnecter.',

  // offline.ts
  'This is not a BOUSOL approval code': 'Ce n’est pas un code d’approbation BOUSOL',
  'Unreadable approval code': 'Code d’approbation illisible',
  'Malformed approval code': 'Code d’approbation mal formé',
  'Device key must be an EC P-256 public key': 'La clé de l’appareil doit être une clé publique EC P-256',
  'Invalid device public key': 'Clé publique de l’appareil invalide',
  'Not a BOUSOL station code': 'Ce n’est pas un code de station-service BOUSOL',

  // ledger.ts
  'Journal entry needs at least two non-zero lines': 'L’écriture comptable doit comporter au moins deux lignes non nulles',
  'Entry to reverse not found': 'Écriture à contrepasser introuvable',
  'Insufficient balance': 'Solde insuffisant',

  // refunds.ts
  'Amount must be positive': 'Le montant doit être positif',
  'Maker-checker: the approver cannot also record the payout':
    'Vous ne pouvez pas enregistrer le paiement d’un remboursement que vous avez approuvé (double contrôle)',

  // allocation.ts
  'Add at least one employee': 'Ajoutez au moins un employé',
  'Amounts must be positive': 'Les montants doivent être positifs',
  'Company is frozen': 'L’entreprise est gelée',
  'No lines are ready to post': 'Aucune ligne n’est prête à être comptabilisée',
  'Maker-checker: the preparer cannot approve their own batch':
    'Vous ne pouvez pas approuver votre propre lot d’allocation (double contrôle)',
  'Line is not held': 'Cette ligne n’est pas retenue',
  'Only a posted (approved) batch can become recurring':
    'Seul un lot d’allocation comptabilisé (approuvé) peut devenir récurrent',
  'Day of month must be 1–28': 'Le jour du mois doit être compris entre 1 et 28',

  // admin.ts
  'Only diesel and gasoline are sold': 'Seuls le diesel et la gazoline sont vendus',
  'Price must be positive': 'Le prix doit être positif',
  'Create employees through the employee roster': 'Créez les employés depuis la liste des employés',
  'Company required': 'Entreprise requise',
  'Station required': 'Station-service requise',
  'Valid phone number required': 'Numéro de téléphone valide requis',
  'Password is incorrect': 'Mot de passe incorrect',
  'Invalid PIN key': 'Clé de code PIN invalide',
  'Enroll from the phone this wallet is bound to': 'Effectuez l’enregistrement depuis le téléphone associé à ce portefeuille',
  'A phone is already enrolled. Ask your company admin for assisted recovery.':
    'Un téléphone est déjà enregistré. Demandez une récupération assistée à l’administrateur de votre entreprise.',
  'Cannot freeze that': 'Cet élément ne peut pas être gelé',

  // bank.ts
  'Statement needs a header row and at least one line': 'Le relevé doit contenir une ligne d’en-tête et au moins une ligne',
  'Statement needs at least "reference" and "amount" columns':
    'Le relevé doit contenir au moins les colonnes « reference » et « amount »',

  // redemption.ts
  'Attendant must be signed in on a station terminal': 'Le pompiste doit être connecté sur un terminal de la station-service',
  'Terminal is frozen': 'Le terminal est gelé',
  'Station is frozen': 'La station-service est gelée',
  'Another attendant has an open shift on this terminal': 'Un autre pompiste a un quart ouvert sur ce terminal',
  'No open shift on this terminal': 'Aucun quart ouvert sur ce terminal',
  'Only the shift attendant can close it': 'Seul le pompiste de ce quart peut le fermer',
  'Complete or cancel open redemption requests before closing':
    'Terminez ou annulez les demandes en cours avant de fermer le quart',
  'Request belongs to another terminal': 'Cette demande appartient à un autre terminal',
  'Give either gallons or an amount': 'Indiquez soit un nombre de gallons, soit un montant',
  'Quantity must be positive': 'La quantité doit être positive',
  'Pump number required': 'Numéro de pompe requis',
  'Open your shift first': 'Ouvrez d’abord votre quart',
  'Wallet locked after too many wrong PINs': 'Portefeuille bloqué après trop de codes PIN incorrects',
  'This approval was made for a different request': 'Cette approbation a été faite pour une autre demande',
  'Approval code is too old. Ask the employee to scan the QR again.':
    'Le code d’approbation est trop ancien. Demandez à l’employé de scanner à nouveau le code QR.',
  'Approval code is not from this employee’s registered phone':
    'Le code d’approbation ne provient pas du téléphone enregistré de cet employé',
  'This approval code was already used': 'Ce code d’approbation a déjà été utilisé',
  'This fuel wallet is frozen': 'Ce portefeuille de carburant est gelé',
  'This company’s program is frozen': 'Le programme de cette entreprise est gelé',
  'Wallet locked after too many wrong PINs. The company admin must do assisted recovery.':
    'Portefeuille bloqué après trop de codes PIN incorrects. L’administrateur de l’entreprise doit effectuer une récupération assistée.',
  'Station is not accepting redemptions': 'La station-service n’accepte pas de transactions pour le moment',
  'The price changed since the phone last synced. Connect the phone once and try again.':
    'Le prix a changé depuis la dernière synchronisation du téléphone. Connectez le téléphone une fois, puis réessayez.',
  'Request already used': 'Demande déjà utilisée',
  'Cannot dispense more than the employee approved': 'Impossible de distribuer plus que ce que l’employé a approuvé',
  'Not your request': 'Cette demande n’est pas la vôtre',

  // station-offline.ts
  'Offline mode is only available on a registered station terminal':
    'Le mode hors ligne n’est disponible que sur un terminal de station-service enregistré',
  'This terminal or station is frozen': 'Ce terminal ou cette station-service est gelé',
  'Invalid timestamp in offline sale': 'Horodatage invalide dans une vente hors ligne',

  // exceptions.ts
  'Only completed fuelings can be disputed': 'Seuls les ravitaillements terminés peuvent être contestés',
  'A dispute is already open for this fueling': 'Une contestation est déjà ouverte pour ce ravitaillement',
  'Variance can only be explained and accepted': 'Un écart peut seulement être expliqué et accepté',
  'Reversal must be within the amount charged': 'Le montant à rembourser ne peut pas dépasser le montant facturé',
  'Disputes are reversed or rejected': 'Une contestation est soit remboursée, soit rejetée',
  'Offline exceptions are acknowledged with a note': 'Les exceptions hors ligne sont validées avec une note',
  'Adjustments are proposed at creation': 'Les ajustements sont proposés lors de leur création',
  'Nothing proposed yet': 'Aucune proposition pour le moment',
  'Maker-checker: the proposer cannot approve their own proposal':
    'Vous ne pouvez pas approuver votre propre proposition (double contrôle)',
  'Reversal exceeds the amount charged': 'Le remboursement dépasse le montant facturé',

  // funding.ts
  'Imported bank line amount differs from the expected amount':
    'Le montant de la ligne bancaire importée diffère du montant attendu',
  'Maker-checker: the person who matched the deposit cannot activate it':
    'Vous ne pouvez pas activer un dépôt que vous avez vous-même rapproché (double contrôle)',
};

type Rule = [RegExp, (...groups: string[]) => string];

/** Templated messages. Order matters: specific patterns first. */
const RULES: Rule[] = [
  // auth.ts
  [/^Requires role: (.+)$/, (roles) => `Rôle requis : ${roles.split(' or ').map((r) => ROLE[r] ?? r).join(' ou ')}`],
  [/^This terminal belongs to (.+)\. Sign in with an attendant account for (.+), or activate this device for your own station\.$/,
    (s1, s2) => `Ce terminal appartient à ${s1}. Connectez-vous avec un compte pompiste de ${s2}, ou activez cet appareil pour votre propre station-service.`],

  // redemption.ts
  [/^Wrong PIN \((-?\d+) tries left\)\. Ask the employee to try again\.$/,
    (n) => `Code PIN incorrect (${n} ${Number(n) > 1 ? 'essais restants' : 'essai restant'}). Demandez à l’employé de réessayer.`],
  [/^Your company has no (\w+) price yet$/, (g) => `Votre entreprise n’a pas encore de prix pour ${gradeWithArticle(g)}`],

  // funding.ts
  [/^No active (\w+) contract price for this company$/, (g) => `Aucun prix contractuel actif pour ${gradeWithArticle(g)} pour cette entreprise`],
  [/^Funding is (\w+); it must be matched first$/, (s) => `Le financement est ${status(s, 'm')} ; il doit d’abord être rapproché`],
  [/^Bank amount (\S+) does not equal expected (\S+)$/, (a, b) => `Le montant bancaire ${a} ne correspond pas au montant attendu ${b}`],
  [/^Bank reference already matched to (.+)$/, (ref) => `Référence bancaire déjà rapprochée de ${ref}`],
  [/^Bank line (.+) is (\w+)$/, (ref, s) => `La ligne bancaire ${ref} est ${status(s, 'f')}`],

  // refunds.ts
  [/^Only (\S+) (\S+) of (.+) is unallocated$/, (amt, ccy, lot) => `Seuls ${amt} ${ccy} du lot ${lot} ne sont pas encore alloués`],

  // allocation.ts
  [/^Employee (.+) not in company$/, (id) => `L’employé ${id} n’appartient pas à cette entreprise`],
  [/^(.+) appears twice in the batch$/, (name) => `${name} figure deux fois dans le lot d’allocation`],

  // ledger.ts
  [/^Invalid journal line on (.+)$/, (a) => `Ligne d’écriture invalide sur le compte ${a}`],
  [/^Entry is unbalanced for (.+) by (\S+)$/, (key, diff) => `L’écriture est déséquilibrée de ${diff} pour ${key}`],
  [/^Insufficient balance in (.+)$/, (a) => `Solde insuffisant sur le compte ${a}`],

  // "<thing> is <status>" (refunds, allocation, bank, redemption, exceptions, funding, admin freezes)
  [new RegExp(`^(${Object.keys(SUBJECT).join('|')}) is ([a-z_]+)$`), (subj, s) => {
    const [fr, g] = SUBJECT[subj];
    return `${fr} est ${status(s, g)}`;
  }],
  // allocation.ts: "<employee name> is <status>"
  [/^(.+) is ([a-z_]+)$/, (name, s) => `Le compte de ${name} est ${status(s, 'm')}`],

  // errors.notFound
  [/^(.+) not found$/, (what) => `${NOUN[what] ?? what} introuvable`],
];

function translate(message: string, exact: Record<string, string>, rules: Rule[]): string | undefined {
  const hit = exact[message];
  if (hit !== undefined) return hit;
  for (const [re, fn] of rules) {
    const m = re.exec(message);
    if (m) return fn(...m.slice(1));
  }
  return undefined;
}

/** Translates an API error message. Unknown messages are returned unchanged (English). */
export function localize(message: string, lang: Lang): string {
  if (lang === 'en' || typeof message !== 'string') return message;
  return frenchNumbers(translate(message, EXACT, RULES) ?? message);
}

/** English-formatted amounts in a French message ("2,000.00 HTG", "3.5 gal") become "2 000,00 HTG", "3,5 gal". */
export function frenchNumbers(text: string): string {
  return text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?=\s?(?:HTG|gal)\b)/g, (_m, int: string, dec?: string) =>
    int.replace(/,/g, '\u202f') + (dec ? `,${dec}` : ''));
}

// ----------------------------------------------------------------------------- validation (zod) messages

const ZOD_EXACT: Record<string, string> = {
  Required: 'Obligatoire',
  'Invalid input': 'Saisie invalide',
  'Expected number, received nan': 'Nombre attendu',
  'Invalid email': 'Adresse e-mail invalide',
  'Invalid date': 'Date invalide',
};
const ZOD_TYPE: Record<string, string> = {
  string: 'texte', number: 'nombre', integer: 'nombre entier', float: 'nombre décimal', boolean: 'booléen',
  object: 'objet', array: 'liste', null: 'vide', undefined: 'rien', nan: 'NaN', date: 'date',
};
const zt = (t: string) => ZOD_TYPE[t] ?? t;
const ZOD_RULES: Rule[] = [
  [/^Expected (\w+), received (\w+)$/, (a, b) => `${zt(a)} attendu, ${zt(b)} reçu`],
  [/^String must contain at least (\d+) character\(s\)$/, (n) => `Doit contenir au moins ${n} caractère(s)`],
  [/^String must contain at most (\d+) character\(s\)$/, (n) => `Doit contenir au plus ${n} caractère(s)`],
  [/^String must contain exactly (\d+) character\(s\)$/, (n) => `Doit contenir exactement ${n} caractère(s)`],
  [/^Array must contain at most (\d+) element\(s\)$/, (n) => `Doit contenir au plus ${n} élément(s)`],
  [/^Array must contain at least (\d+) element\(s\)$/, (n) => `Doit contenir au moins ${n} élément(s)`],
  [/^Number must be greater than or equal to (\S+)$/, (n) => `Doit être supérieur ou égal à ${n}`],
  [/^Number must be greater than (\S+)$/, (n) => `Doit être supérieur à ${n}`],
  [/^Number must be less than or equal to (\S+)$/, (n) => `Doit être inférieur ou égal à ${n}`],
  [/^Number must be less than (\S+)$/, (n) => `Doit être inférieur à ${n}`],
  [/^Invalid enum value\. Expected (.+), received (.+)$/, (a, b) => `Valeur invalide. Attendu : ${a.replace(/ \| /g, ' ou ')}, reçu : ${b}`],
  [/^Invalid discriminator value\. Expected (.+)$/, (a) => `Valeur de discriminant invalide. Attendu : ${a.replace(/ \| /g, ' ou ')}`],
];

/** Translates one zod issue message. */
export function localizeValidation(message: string, lang: Lang): string {
  if (lang === 'en') return message;
  return translate(message, ZOD_EXACT, ZOD_RULES) ?? message;
}

// ----------------------------------------------------------------------------- data shown by the UI

/** Offline-sync rejection reasons (station-offline.ts), as stored and returned to the terminal. */
const OFFLINE_REASON: Record<string, string> = {
  'invalid sale data': 'données de vente invalides',
  'unknown shift for this terminal': 'quart inconnu pour ce terminal',
  'unreadable approval code': 'code d’approbation illisible',
  'approval code does not match the sale': 'le code d’approbation ne correspond pas à la vente',
  'amount exceeds what the employee approved': 'le montant dépasse ce que l’employé a approuvé',
  'signature does not match a registered phone': 'la signature ne correspond à aucun téléphone enregistré',
  'phone key was revoked before the sale': 'la clé du téléphone a été révoquée avant la vente',
  'approval code already used': 'code d’approbation déjà utilisé',
  'wrong PIN': 'code PIN incorrect',
};

/** Exception summaries generated by the server (stored in English). */
const SUMMARY_RULES: Rule[] = [
  [/^(.+): offline sale of (\S+ \S+) rejected at sync \((.+)\)$/,
    (st, amt, reason) => `${st} : vente hors ligne de ${amt} rejetée à la synchronisation (${OFFLINE_REASON[reason] ?? reason})`],
  [/^(.+): offline sale to (.+) not covered by (\S+ \S+)$/,
    (st, name, amt) => `${st} : vente hors ligne à ${name} non couverte à hauteur de ${amt}`],
  [/^(.+) shift close: (.+) variance awaiting explanation$/,
    (st, parts) => `${st}, fermeture de quart : écart de ${parts} en attente d’explication`],
  [/^Dispute on (\S+ \S+) \((\S+) gal (\w+)\) at (.+) pump (\d+)$/,
    (amt, gal, g, st, pump) => `Contestation sur ${amt} (${gal} gal de ${gradeName(g)}) à ${st}, pompe ${pump}`],
  [/^Return (\S+ \S+) from (.+) to company pool$/,
    (amt, name) => `Restitution de ${amt} de ${name} au solde non alloué de l’entreprise`],
];

/** Translates server-generated text that is returned as data (sync reasons, exception summaries). */
export function localizeData(text: string, lang: Lang): string {
  if (lang === 'en') return text;
  return frenchNumbers(translate(text, OFFLINE_REASON, SUMMARY_RULES) ?? text);
}

/**
 * `reason` is only server-generated on offline-sale records: sync results ({ clientId, status: 'rejected' })
 * and offline exception details ({ chargedMinor, pump }). Elsewhere (refunds, freezes…) a person typed it.
 */
const isOfflineRecord = (o: Record<string, any>) =>
  ('clientId' in o && o.status === 'rejected') || ('chargedMinor' in o && 'pump' in o);

/**
 * Returns a copy of a response payload with server-generated `summary` strings and offline-sale `reason`s
 * translated. Only known texts change (exact offline reasons and summary templates).
 */
export function localizePayload<T>(payload: T, lang: Lang): T {
  if (lang === 'en') return payload;
  const walk = (v: any, depth: number): any => {
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      const generated = k === 'summary' || (k === 'reason' && isOfflineRecord(v));
      out[k] = typeof x === 'string' && generated ? localizeData(x, lang) : walk(x, depth + 1);
    }
    return out;
  };
  return walk(payload, 0);
}
