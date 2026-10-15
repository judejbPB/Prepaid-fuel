// French for UI strings in the employee screens, keyed by the English text passed to t().
export const fr: Record<string, string> = {
  // Tabs and headings
  'My fuel': 'Mon carburant',
  'Pay at pump': 'Payer à la pompe',
  'History': 'Historique',
  'Sign out': 'Se déconnecter',
  'Wallet on another phone': 'Portefeuille sur un autre téléphone',
  'Set up this phone': 'Configurer ce téléphone',
  'Approve fueling': 'Approuver le plein',
  'Show this to the attendant': 'Montrez ce code au pompiste',
  'What went wrong?': 'Quel est le problème ?',
  'My disputes': 'Mes contestations',

  // Wallet loading and states
  'Loading your wallet…': 'Chargement de votre portefeuille…',
  'Connect to the internet once to load your wallet. After that it works offline.':
    'Connectez-vous une fois à Internet pour charger votre portefeuille. Il fonctionnera ensuite hors ligne.',
  'This browser can’t secure a wallet. Use Chrome or Safari, over HTTPS.':
    'Ce navigateur ne peut pas sécuriser votre portefeuille. Utilisez Chrome ou Safari (en HTTPS).',
  'Your fuel wallet is registered to a different phone, or this phone’s security key was erased.':
    'Votre portefeuille carburant est enregistré sur un autre téléphone, ou la clé de sécurité de ce téléphone a été effacée.',
  'Ask your company admin for assisted recovery, then sign in again here to register this phone.':
    'Demandez une récupération assistée à l’administrateur de votre entreprise, puis reconnectez-vous ici pour enregistrer ce téléphone.',
  'Offline.': 'Hors ligne.',
  'Balance as of {time}. You can still pay at the pump.': 'Solde au {time}. Vous pouvez quand même payer à la pompe.',

  // Balance
  'Your fuel wallet is frozen. Contact your company admin.':
    'Votre portefeuille carburant est gelé. Contactez l’administrateur de votre entreprise.',
  'Available': 'Disponible',
  'Diesel or gasoline': 'Diesel ou gazoline',
  'earliest expiry {date}': 'première expiration le {date}',
  'About how much fuel that buys': 'Équivalent approximatif en carburant',
  'at {price}/gal': 'à {price}/gal',
  '{amount} approved at the pump and not yet synced.': 'Montant de {amount} approuvé à la pompe, pas encore synchronisé.',
  '{amount} reserved for a fueling in progress.': 'Montant de {amount} réservé pour un plein en cours.',
  'Where my balance comes from': 'D’où vient mon solde',
  'exp. {date}': 'exp. {date}',

  // Enrollment
  'This phone is now your fuel wallet': 'Ce téléphone est maintenant votre portefeuille carburant',
  'Choose a PIN. You’ll enter it to approve every fueling, even with no internet. This phone becomes your only wallet device.':
    'Choisissez un code PIN. Vous le saisirez pour approuver chaque plein, même sans Internet. Ce téléphone deviendra le seul appareil de votre portefeuille.',
  'Setup needs an internet connection, just this once.': 'La configuration nécessite une connexion Internet, une seule fois.',
  'Account password': 'Mot de passe du compte',
  'New PIN (4–6 digits)': 'Nouveau code PIN (4 à 6 chiffres)',
  'Repeat PIN': 'Confirmez le code PIN',
  'Secure my wallet': 'Sécuriser mon portefeuille',

  // Scan and confirm
  'Scan the QR on the station terminal. No internet needed.':
    'Scannez le QR affiché sur le terminal de la station. Pas besoin d’Internet.',
  'Scan station QR': 'Scanner le QR de la station',
  'Scan the station QR': 'Scanner le QR de la station',
  'Unreadable station code.': 'Code de station illisible.',
  'Station': 'Station',
  'Pump': 'Pompe',
  'Fuel': 'Carburant',
  'No {grade} price on this phone yet. Connect once to sync.':
    'Aucun prix {grade} sur ce téléphone pour l’instant. Connectez-vous une fois pour le synchroniser.',
  'Amount': 'Montant',
  'you have {amount}': 'vous avez {amount}',
  'Your balance is too low for this request.': 'Votre solde est insuffisant pour cette demande.',
  'Confirm with PIN': 'Confirmez avec votre code PIN',
  'Confirm': 'Confirmer',
  'Not me / cancel': 'Ce n’est pas moi / annuler',

  // Approval code
  'Approval code': 'Code d’approbation',
  'valid {s}s': 'valide {s} s',
  'Works once, for this pump only. A screenshot of it is useless.':
    'Valable une seule fois, pour cette pompe uniquement. Une capture d’écran ne fonctionnera pas.',
  'This code expired. Scan the station QR again.': 'Ce code a expiré. Scannez à nouveau le QR de la station.',
  'Done': 'Terminé',

  // Receipt and disputes
  'Redeemed': 'Servi',
  'Approved — attendant is dispensing': 'Approuvé — le pompiste sert le carburant',
  'Pump {n}': 'Pompe {n}',
  'New balance': 'Nouveau solde',
  '{amount} not used was returned to your balance.': 'Le montant non utilisé ({amount}) a été recrédité sur votre solde.',
  'Raise a dispute': 'Contester ce plein',
  'Cancel before fueling': 'Annuler avant le plein',
  'Back to my fuel': 'Retour à mon carburant',
  'e.g. The pump showed 7 gallons, not 12': 'ex. : la pompe affichait 7 gallons, pas 12',
  'Dispute sent to the station and distributor': 'Contestation envoyée à la station et au distributeur',
  'Send dispute': 'Envoyer la contestation',
  'Cancel': 'Annuler',

  // History
  'Not yet synced': 'Pas encore synchronisé',
  'approved {time}': 'approuvé le {time}',
  'No fuelings yet.': 'Aucun plein pour le moment.',
  'Receipts open when you’re back online.': 'Les reçus seront disponibles dès votre retour en ligne.',

  // Errors from offline.ts
  'This is not a BOUSOL station code': 'Ce n’est pas un code de station BOUSOL',
  'This phone is not enrolled': 'Ce téléphone n’est pas enregistré',
};
