// French for the fuel alerts screen (web/src/apps/alerts.tsx). Neutral wording: an alert flags a pattern
// to check, it does not accuse anyone.
export const fr: Record<string, string> = {
  'Fuel alerts': 'Alertes carburant',
  'Large fill': 'Plein important',
  'Repeated fueling': 'Pleins rapprochés',
  'High daily volume': 'Volume journalier élevé',
  'Night fueling': 'Plein de nuit',
  'Repeated shift differences': 'Écarts de caisse répétés',
  'Mostly offline sales': 'Ventes surtout hors ligne',
  '{gal} gal of {grade} in one fueling (limit {limit} gal).': '{gal} gal de {grade} en un seul plein (limite {limit} gal).',
  'Two fuelings {minutes} min apart at two different stations ({a}, then {b}); {gal} gal in total.':
    'Deux pleins à {minutes} min d’intervalle dans deux stations différentes ({a}, puis {b}) ; {gal} gal au total.',
  'Two fuelings {minutes} min apart at the same station; {gal} gal in total.': 'Deux pleins à {minutes} min d’intervalle dans la même station ; {gal} gal au total.',
  '{gal} gal in {count} fuelings on {day} (limit {limit} gal per day).': '{gal} gal en {count} pleins le {day} (limite {limit} gal par jour).',
  'Fueling at {hour}h, Haiti time ({gal} gal).': 'Plein à {hour} h, heure d’Haïti ({gal} gal).',
  '{n} shifts with cash or meter differences in the last {days} days.': '{n} quarts avec des écarts de caisse ou de compteur au cours des {days} derniers jours.',
  '{pct}% of this terminal’s sales this week were offline ({offline} of {total}). Offline sales are only checked when the terminal reconnects.':
    '{pct} % des ventes de ce terminal cette semaine ont été faites hors ligne ({offline} sur {total}). Les ventes hors ligne ne sont vérifiées qu’à la reconnexion du terminal.',
  'High': 'Élevée',
  'Medium': 'Moyenne',
  'Low': 'Faible',
  'Fixed rules look at the last 30 days of fuel sales and shifts and flag patterns worth a look. An alert blocks nothing and accuses no one: a person checks it, then marks it normal or to follow up. To stop an employee or a terminal, use Freeze in Clients & stations.':
    'Des règles fixes examinent les ventes de carburant et les quarts des 30 derniers jours et signalent les cas à vérifier. Une alerte ne bloque rien et n’accuse personne : une personne la vérifie, puis la classe normale ou à suivre. Pour bloquer un employé ou un terminal, utilisez « Geler » dans Clients et stations.',
  'Show reviewed alerts': 'Afficher les alertes examinées',
  'To follow up': 'À suivre',
  'Normal': 'Normale',
  'No alerts in the last 30 days.': 'Aucune alerte au cours des 30 derniers jours.',
  'No alerts to review.': 'Aucune alerte à examiner.',
  'Only the distributor admin or approver can review alerts.': 'Seuls l’administrateur et l’approbateur distributeur peuvent examiner les alertes.',
  'Mark as normal': 'Classer comme normale',
  'Mark to follow up': 'Classer à suivre',
  'Why is it normal? (e.g. delivery truck with a 50 gal tank)': 'Pourquoi est-ce normal ? (p. ex. camion de livraison avec un réservoir de 50 gal)',
  'What happens next? (e.g. call the company, check the pump camera)': 'Quelle est la suite ? (p. ex. appeler l’entreprise, vérifier la caméra de la pompe)',
  'Alert reviewed': 'Alerte examinée',
  '{n} fuel alert(s) to review.': '{n} alerte(s) carburant à examiner.',
};
