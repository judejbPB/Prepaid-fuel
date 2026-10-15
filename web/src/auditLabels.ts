// Readable names for audit-log action codes, entities and detail fields (French via t()).
import { cap } from './api';
import { t } from './i18n';

const ACTIONS: Record<string, () => string> = {
  'bank.ignore': () => t('Bank line ignored'), 'bank.import': () => t('Bank statement imported'), 'bank.ai_suggest': () => t('AI match suggested'),
  'sage.settings': () => t('Sage codes changed'), 'sage.export': () => t('Sage export downloaded'),
  'batch.approve': () => t('Allocation batch approved'), 'batch.create': () => t('Allocation batch created'),
  'batch.post': () => t('Allocation batch posted'), 'batch.reject': () => t('Allocation batch rejected'),
  'batch.release_hold': () => t('Held allocation line released'), 'batch.submit': () => t('Allocation batch submitted'),
  'company.create': () => t('Company created'), 'contract.set': () => t('Contract price set'),
  'device.enroll': () => t('Phone enrolled'), 'employee.create': () => t('Employee added'),
  'employee.recover': () => t('Employee access recovered'), 'exception.adjustment': () => t('Adjustment requested'),
  'exception.decline': () => t('Exception proposal declined'), 'exception.dispute': () => t('Dispute opened'),
  'exception.propose': () => t('Exception resolution proposed'), 'exception.resolve': () => t('Exception resolved'),
  'funding.approve': () => t('Deposit activated'), 'funding.create': () => t('Funding announced'),
  'funding.match': () => t('Deposit matched to bank'), 'funding.reject': () => t('Funding rejected'),
  login: () => t('Signed in'), 'lot.expire': () => t('Lot expired'),
  'offline.pack': () => t('Offline data downloaded'), 'offline.sync': () => t('Offline sales synced'),
  'pin.failed': () => t('Wrong PIN'), 'recurring.auto_pause': () => t('Recurring benefit paused automatically'),
  'recurring.create': () => t('Recurring benefit created'),
  'recurring.paused': () => t('Recurring benefit paused'), 'recurring.active': () => t('Recurring benefit resumed'),
  'recurring.cancelled': () => t('Recurring benefit cancelled'), 'redemption.authorize': () => t('Fuel request approved'),
  'redemption.bad_signature': () => t('Rejected approval code (bad signature)'), 'redemption.cancel': () => t('Fuel request cancelled'),
  'redemption.complete': () => t('Fuel sale confirmed'), 'redemption.replay': () => t('Reused approval code rejected'),
  'redemption.request': () => t('Fuel request created'), 'refund.approve': () => t('Refund approved'),
  'refund.pay': () => t('Refund paid'), 'refund.reject': () => t('Refund rejected'), 'refund.request': () => t('Refund requested'),
  'shift.close': () => t('Shift closed'), 'shift.open': () => t('Shift opened'), 'station.create': () => t('Station created'),
  'terminal.activate': () => t('Terminal activated'), 'terminal.create': () => t('Terminal created'), 'user.create': () => t('User created'),
  freeze: () => t('Frozen'), unfreeze: () => t('Unfrozen'),
};

const FIELDS: Record<string, () => string> = {
  employee: () => t('Employee'), device: () => t('Phone'), counter: () => t('Counter'), amount: () => t('Amount'),
  grade: () => t('Fuel'), pump: () => t('Pump'), title: () => t('Title'), lines: () => t('Lines'), login: () => t('Login'),
  role: () => t('Role'), name: () => t('Name'), approvalThreshold: () => t('Approval threshold'), address: () => t('Address'),
  terminalId: () => t('Terminal'), reason: () => t('Reason'), reference: () => t('Reference'), code: () => t('Code'),
  label: () => t('Label'), stationId: () => t('Station'), companyId: () => t('Company'), status: () => t('Status'),
  from: () => t('From'), to: () => t('To'), entries: () => t('Entries'), format: () => t('File'), mode: () => t('Detail'),
  journal: () => t('Journal code'), suggestions: () => t('AI suggestions'),
};

export const auditAction = (code: string) => ACTIONS[code]?.() ?? code;
const ENTITIES: Record<string, () => string> = {
  allocation_line: () => t('Allocation line'), bank_statement: () => t('Bank statement'), bank_transaction: () => t('Bank line'),
  sage_settings: () => t('Sage codes'), sage_export: () => t('Sage export'),
  batch: () => t('Allocation batch'), company: () => t('Company'), contract: () => t('Contract price'), employee: () => t('Employee'),
  exception: () => t('Exception'), funding: () => t('Funding'), lot: () => t('Lot'), recurring: () => t('Recurring benefit'),
  redemption: () => t('Fuel request'), refund: () => t('Refund'), shift: () => t('Shift'), station: () => t('Station'),
  terminal: () => t('Terminal'), user: () => t('User'),
};

export const auditEntity = (entity: string | null) => (entity ? ENTITIES[entity]?.() ?? cap(entity) : '');

/** "role: co_approver" style JSON → "Rôle : Co approver · Nom : …" */
export function auditDetails(json: string | null): string {
  if (!json) return '';
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return String(data);
    return Object.entries(data).map(([k, v]) => {
      const label = FIELDS[k]?.() ?? k;
      const value = k === 'role' || k === 'grade' || k === 'status' ? cap(String(v)) : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${label} : ${value}`;
    }).join(' · ');
  } catch {
    return json;
  }
}
