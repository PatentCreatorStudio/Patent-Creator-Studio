// Costs, deadlines and legal help.
import { S, main } from './core.js';

export function renderHelp() {
  main.innerHTML = `<div class="page doc" style="max-width:820px">
  <h1>Costs and legal help</h1>
  <p>This app provides drafts, not legal advice or approval to file. Have a registered patent attorney or agent review your application before filing.</p>

  <h2>US filing fees</h2>
  <table><tr><th>Provisional application fee category</th><th>Filing fee</th></tr>
  <tr><td>Micro entity</td><td>$65</td></tr><tr><td>Small entity</td><td>$130</td></tr><tr><td>Standard</td><td>$325</td></tr></table>
  <p>Checked November 13, 2026. Confirm the <a href="https://www.uspto.gov/learning-and-resources/fees-and-payment/uspto-fee-schedule">USPTO fees</a> before paying. Small and micro entities qualify for reduced fees. Check the <a href="https://www.uspto.gov/PatentMicroentity">eligibility rules</a> before claiming a discount.</p>
  <p>A provisional application can use PDF. A later nonprovisional utility application has an extra fee if its description, claims or abstract use a format other than Word (.docx).</p>

  <h2>Filing deadlines</h2>
  <ul>
  <li><b>Public disclosure can affect patent rights.</b> US law generally allows one year after an inventor’s public disclosure to file. Disclosure before filing can prevent patents abroad. Confirm your dates with a patent practitioner.</li>
  <li><b>A provisional application lasts 12 months.</b> To keep its filing date, file a qualifying follow-up application within that time. If you miss it, contact a patent practitioner immediately: limited restoration may be available. See the <a href="https://www.uspto.gov/patents/basics/apply/provisional-application">USPTO provisional application guide</a>.</li>
  </ul>

  <h2>Free help</h2>
  <ul>
  <li><a href="https://www.uspto.gov/patents/patents-ombuds/pro-se-assistance-center">USPTO Pro Se Assistance Center</a>: explains the filing process. Call 1-866-767-3848. For legal advice, use a registered patent attorney or agent.</li>
  <li><a href="https://www.uspto.gov/patents/basics/using-legal-services/pro-bono/inventors">Patent Pro Bono Program</a>: volunteer patent practitioners for inventors who qualify.</li>
  <li><a href="https://www.uspto.gov/learning-and-resources/ip-policy/public-information-about-practitioners/law-school-clinic-1">Law school clinics</a>: free legal help from supervised students for applicants who qualify.</li>
  </ul>

  <h2>Your responsibility</h2>
  <ul>
  <li>Only people can be inventors. Record who conceived the claimed solution and how. Keep your dated notes. See the <a href="https://www.uspto.gov/subscription-center/2025/revised-inventorship-guidance-ai-assisted-inventions">USPTO guidance on AI-assisted inventions</a>.</li>
  <li>You are responsible for what you sign. Read every file before filing.</li>
  <li>Automated checks flag wording and format problems. A patent practitioner must assess whether your invention qualifies for protection, including whether it is an obvious variation of existing work.</li>
  </ul>

  <h2>Beware invention-promotion companies</h2>
  <p>Companies that ask for thousands of dollars up front to "evaluate" or "market" an invention rarely make their clients money. A call to the USPTO Pro Se Assistance Center is free.</p>
  </div>`;
  main.querySelectorAll('a[href^="http"]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), S.openExternal(a.href))));
}
