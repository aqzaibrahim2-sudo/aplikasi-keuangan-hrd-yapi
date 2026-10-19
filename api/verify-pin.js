export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { pin } = req.body;
  const CORRECT_PIN = process.env.DASHBOARD_PIN || '123456'; // Default fallback PIN jika ENV belum diset

  if (pin === CORRECT_PIN) {
    return res.status(200).json({ success: true, message: 'PIN Valid' });
  } else {
    return res.status(401).json({ success: false, message: 'PIN Salah' });
  }
}
