import { Resend } from 'resend';
import { getAdminNotificationEmail } from '../config/adminNotificationEmail.ts';

let resendInstance: Resend | null = null;

function getResendClient(): Resend | null {
  if (resendInstance) return resendInstance;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'RESEND_API_KEY' || apiKey.includes('your_')) {
    console.warn('[EMAIL SERVICE] RESEND_API_KEY is not configured or is a placeholder. Email delivery will operate in sandbox console-only mode.');
    return null;
  }

  try {
    resendInstance = new Resend(apiKey);
    return resendInstance;
  } catch (error) {
    console.error('[EMAIL SERVICE] Failed to initialize Resend client:', error);
    return null;
  }
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendPaymentReceivedEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendPaymentReceivedEmail(
    to: string,
    ownerPhone: string,
    itemName: string,
    agentBusinessName: string,
    agentPhone: string,
    itemReference: string,
    pickupCode: string
): { subject: string; body: string } {
    const subject = 'Payment Confirmed / Malipo Imethibitishwa - Return4me';
    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          
          <!-- Header -->
          <div style="background-color: #0f172a; padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">Return4me</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Lost-and-found help for Kenya / Huduma ya kurudisha vitu vilivyopotea</p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 24px;">
            
            <!-- English Section -->
            <div style="margin-bottom: 32px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 32px;">
              <h2 style="color: #0f172a; font-size: 18px; margin-top: 0;">Payment Verified successfully!</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Hello, your claim payment has been securely verified. Your found item is safe and ready for pickup at our physical agent collection point.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Collection Details</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Item:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Agent Point:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${agentBusinessName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Agent Phone:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${agentPhone}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Item Reference:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${itemReference}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; color: #64748b; border-top: 1px solid #cbd5e1;"><strong>Secret Pickup Code:</strong></td>
                    <td style="padding: 10px 0; color: #16a34a; font-weight: 700; font-size: 18px; border-top: 1px solid #cbd5e1; font-family: monospace; letter-spacing: 2px;">${pickupCode}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
                <em>Important: This Secret Pickup Code is different from the Item Reference above. Give the Secret Pickup Code to the Agent ONLY when you are physically collecting your item, so they can verify and release it to you. Never share this code with anyone else, including by phone or social media.</em>
              </p>
            </div>

            <!-- Swahili Section -->
            <div>
              <h2 style="color: #0f172a; font-size: 18px; margin-top: 0;">Malipo Imethibitishwa kikamilifu!</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Habari, malipo yako ya kudai bidhaa yamethibitishwa kikamilifu na kwa usalama. Bidhaa yako iliyopotea iko salama na iko tayari kuchukuliwa katika kituo chetu cha Agent.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Maelezo ya Kuchukua</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Kituo cha Agent:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${agentBusinessName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Simu ya Agent:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${agentPhone}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Nambari ya Rejea ya Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${itemReference}</td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; color: #64748b; border-top: 1px solid #cbd5e1;"><strong>Msimbo wa Siri wa Kuchukulia:</strong></td>
                    <td style="padding: 10px 0; color: #16a34a; font-weight: 700; font-size: 18px; border-top: 1px solid #cbd5e1; font-family: monospace; letter-spacing: 2px;">${pickupCode}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
                <em>Muhimu: Msimbo huu wa Siri wa Kuchukulia ni tofauti na Nambari ya Rejea hapo juu. Mpe Agent Msimbo huu wa Siri PEKEE wakati unapokuwa unachukua bidhaa yako kimwili, ili aweze kuthibitisha na kukukabidhi. Usishiriki msimbo huu na mtu mwingine yeyote, hata kwa simu au mitandao ya kijamii.</em>
              </p>
            </div>

          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
            <p style="margin: 0;">&copy; ${new Date().getFullYear()} Return4me. All rights reserved.</p>
            <p style="margin: 4px 0 0 0;">Nairobi, Kenya | support@return4me.co.ke</p>
          </div>

        </div>
      </div>
    `;

  return { subject, body: html };
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendItemHandedOverEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendItemHandedOverEmail(
    to: string,
    phone: string,
    itemName: string,
    dropoffCode: string,
    dateStr: string
): { subject: string; body: string } {
    const subject = 'Item Handed Over Successfully / Bidhaa Imekabidhiwa - Return4me';
    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          
          <!-- Header -->
          <div style="background-color: #0f172a; padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">Return4me</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Lost-and-found help for Kenya / Huduma ya kurudisha vitu vilivyopotea</p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 24px;">
            
            <!-- English Section -->
            <div style="margin-bottom: 32px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 32px;">
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Item Handed Over Successfully!</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Hello, we are pleased to confirm that your found item has been physically verified and handed over to you successfully.
              </p>
              
              <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; border: 1px solid #e2e8f0; margin-top: 20px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Item Handed Over:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Handover Date:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${dateStr}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Verified Owner Phone:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${phone}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Dropoff/Release Code:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 14px; color: #334155; margin-top: 16px;">
                Thank you for using Return4me as your trusted partner.
              </p>
            </div>

            <!-- Swahili Section -->
            <div>
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Bidhaa Imekabidhiwa kikamilifu!</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Habari, tunafurahi kuthibitisha kuwa bidhaa yako iliyopatikana imethibitishwa kihalisi na kukabidhiwa kwako kikamilifu na kwa mafanikio.
              </p>
              
              <div style="background-color: #f8fafc; border-radius: 8px; padding: 16px; border: 1px solid #e2e8f0; margin-top: 20px;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Bidhaa Iliyokabidhiwa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Tarehe ya Makabidhiano:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${dateStr}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Simu ya Mmiliki Aliyethibitishwa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${phone}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Msimbo wa Kuchukulia:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 14px; color: #334155; margin-top: 16px;">
                Asante kwa kutumia Return4me kama mshirika wako unayemwamini.
              </p>
            </div>

          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
            <p style="margin: 0;">&copy; ${new Date().getFullYear()} Return4me. All rights reserved.</p>
            <p style="margin: 4px 0 0 0;">Nairobi, Kenya | support@return4me.co.ke</p>
          </div>

        </div>
      </div>
    `;

  return { subject, body: html };
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendAdminNewReassignmentRequestEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendAdminNewReassignmentRequestEmail(
    dropoffCode: string,
    locationDescription: string,
    finderPhone: string
): { subject: string; body: string } {
    const subject = `[URGENT] Manual Agent Reassignment Needed - Dropoff Code ${dropoffCode}`;
    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #fef2f2; padding: 24px; color: #991b1b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #fee2e2; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          
          <div style="background-color: #991b1b; padding: 24px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 20px; font-weight: 700;">Manual Reassignment Review Required</h1>
            <p style="margin: 4px 0 0 0; font-size: 13px; color: #fecaca;">Return4me - Admin Operations Alert</p>
          </div>

          <div style="padding: 24px; color: #374151;">
            <p style="font-size: 15px; font-weight: 500;">Hello Administrator,</p>
            <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
              A new found item has been reported, but because GPS was missing and/or automatic geocoding was unable to map the description to a nearby physical agent, the system assigned the default fallback agent.
            </p>
            
            <div style="background-color: #f9fafb; border-radius: 8px; padding: 16px; border: 1px solid #e5e7eb; margin: 20px 0;">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <td style="padding: 6px 0; color: #6b7280; width: 35%;"><strong>Item Code:</strong></td>
                  <td style="padding: 6px 0; color: #111827; font-weight: 600; font-family: monospace;">${dropoffCode}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Reported Location:</strong></td>
                  <td style="padding: 6px 0; color: #111827; font-weight: 500;">${locationDescription}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Finder Phone:</strong></td>
                  <td style="padding: 6px 0; color: #111827; font-weight: 500;">${finderPhone}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Issue:</strong></td>
                  <td style="padding: 6px 0; color: #dc2626; font-weight: 600;">Fallback Agent Assigned</td>
                </tr>
              </table>
            </div>

            <p style="font-size: 14px; color: #4b5563;">
              Please log in to the Return4me Admin dashboard immediately, inspect the item location description, and manually reassign this item to the appropriate nearest agent to ensure a smooth drop-off process.
            </p>

            <div style="text-align: center; margin-top: 24px;">
              <a href="https://return4me.co.ke/admin" style="display: inline-block; background-color: #991b1b; color: #ffffff; padding: 12px 24px; border-radius: 6px; font-weight: 600; text-decoration: none; font-size: 14px;">Open Admin Dashboard</a>
            </div>
          </div>

          <div style="background-color: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af;">
            This is an automated internal notification from Return4me.
          </div>

        </div>
      </div>
    `;

  return { subject, body: html };
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendAgentPaymentConfirmedEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendAgentPaymentConfirmedEmail(
    to: string,
    agentBusinessName: string,
    itemName: string,
    dropoffCode: string,
    claimId: string
): { subject: string; body: string } {
    const subject = 'Payment Confirmed / Release Authorized - Return4me';
    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          
          <!-- Header -->
          <div style="background-color: #0f172a; padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">Return4me</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Lost-and-found help for Kenya / Huduma ya kurudisha vitu vilivyopotea</p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 24px;">
            
            <!-- English Section -->
            <div style="margin-bottom: 32px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 32px;">
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Payment Received! Release Authorized</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Hello ${agentBusinessName}, we have received and verified the escrow payment for the item held at your branch. You are now authorized to release the item to the verified owner when they present the valid release code.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Release Authorization</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Item:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Item Code:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Claim ID:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${claimId}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
                <em>Important: Do not hand over the item until the owner provides the matching release code. Please verify the code in your Agent Portal before handover.</em>
              </p>
            </div>

            <!-- Swahili Section -->
            <div>
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Malipo Imepokelewa! Ruhusa ya Kukabidhi</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Habari ${agentBusinessName}, tumepokea na kuthibitisha malipo ya escrow kwa bidhaa inayoshikiliwa kwenye tawi lako. Sasa umeruhusiwa kukabidhi bidhaa hiyo kwa mmiliki aliyethibitishwa atakapowasilisha msimbo sahihi wa kuchukulia.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Ruhusa ya Makabidhiano</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Msimbo wa Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Nambari ya Dai:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${claimId}</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 13px; color: #64748b; margin-top: 16px;">
                <em>Muhimu: Usikabidhi bidhaa hadi mmiliki atakapowasilisha msimbo wa kuchukulia unaolingana. Tafadhali thibitisha msimbo huo kwenye Agent Portal kabla ya makabidhiano.</em>
              </p>
            </div>

          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
            <p style="margin: 0;">&copy; ${new Date().getFullYear()} Return4me. All rights reserved.</p>
            <p style="margin: 4px 0 0 0;">Nairobi, Kenya | support@return4me.co.ke</p>
          </div>

        </div>
      </div>
    `;

  return { subject, body: html };
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendFinderItemCollectedEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendFinderItemCollectedEmail(
    to: string,
    itemName: string,
    dropoffCode: string
): { subject: string; body: string } {
    const subject = 'Your Found Item Has Been Returned / Bidhaa Uliyopata Imerejeshwa - Return4me';
    const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; background-color: #f8fafc; padding: 24px; color: #1e293b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05);">
          
          <!-- Header -->
          <div style="background-color: #0f172a; padding: 32px 24px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em;">Return4me</h1>
            <p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Lost-and-found help for Kenya / Huduma ya kurudisha vitu vilivyopotea</p>
          </div>

          <!-- Body Content -->
          <div style="padding: 32px 24px;">
            
            <!-- English Section -->
            <div style="margin-bottom: 32px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 32px;">
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Thank You! The Item You Found Has Been Returned</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Hello, we are incredibly pleased to inform you that the item you reported as found has been successfully handed over and returned to its verified true owner!
              </p>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Your honesty, quick action, and civic responsibility have made a huge difference in helping a fellow citizen.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Returned Item Details</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Item Name:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Item Code:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Status:</strong></td>
                    <td style="padding: 6px 0; color: #16a34a; font-weight: 700;">Successfully Reclaimed</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 14px; color: #334155; margin-top: 16px;">
                As a reward and thanks for your outstanding honesty, your split payout has been dispatched directly to your registered M-Pesa phone number. Thank you for making Return4me a trusted community!
              </p>
            </div>

            <!-- Swahili Section -->
            <div>
              <h2 style="color: #16a34a; font-size: 18px; margin-top: 0;">Asante! Bidhaa Uliyopata Imerejeshwa kwa Mmiliki</h2>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Habari, tunafurahi sana kukujulisha kuwa bidhaa uliyoiripoti kama imepatikana imekabidhiwa na kurudishwa kwa mafanikio kwa mmiliki wake halisi aliyethibitishwa!
              </p>
              <p style="font-size: 15px; line-height: 1.6; color: #334155;">
                Uaminifu wako, hatua yako ya haraka, na uwajibikaji wako wa kiraia vimesaidia sana katika kumsaidia mwananchi mwenzako.
              </p>
              
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 20px; margin-top: 20px;">
                <h3 style="margin-top: 0; font-size: 15px; color: #0f172a; text-transform: uppercase; letter-spacing: 0.05em;">Maelezo ya Bidhaa Iliyorejeshwa</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Jina la Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500;">${itemName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Msimbo wa Bidhaa:</strong></td>
                    <td style="padding: 6px 0; color: #0f172a; font-weight: 500; font-family: monospace;">${dropoffCode}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #64748b;"><strong>Hali:</strong></td>
                    <td style="padding: 6px 0; color: #16a34a; font-weight: 700;">Imerejeshwa Kikamilifu</td>
                  </tr>
                </table>
              </div>
              <p style="font-size: 14px; color: #334155; margin-top: 16px;">
                Kama zawadi na shukrani kwa uaminifu wako mkubwa, malipo yako ya mgao yametumwa moja kwa moja kwenye nambari yako ya simu ya M-Pesa iliyosajiliwa. Asante kwa kuifanya Return4me kuwa jamii ya kuaminika!
              </p>
            </div>

          </div>

          <!-- Footer -->
          <div style="background-color: #f8fafc; padding: 24px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
            <p style="margin: 0;">&copy; ${new Date().getFullYear()} Return4me. All rights reserved.</p>
            <p style="margin: 4px 0 0 0;">Nairobi, Kenya | support@return4me.co.ke</p>
          </div>

        </div>
      </div>
    `;

  return { subject, body: html };
}


/**
 * N8 PURE subject/body builder, extracted verbatim from sendAdminTransactionLogEmail().
 *
 * Sends nothing, reaches no provider and reads no configuration, so it is
 * safe to call from NotificationService.render(), which evaluates it
 * transiently at dispatch time and then discards the result. The body may
 * contain sensitive values (a pickup code, a phone number) exactly as
 * before; that is precisely why it must stay transient, because the durable
 * notification row never stores it.
 */
export function renderSendAdminTransactionLogEmail(
    event: 'PAYMENT_CONFIRMED' | 'HANDOVER_CONFIRMED' | 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
    claimId: string,
    itemId: string,
    amount: number | string,
    agentName: string
): { subject: string; body: string } {
    const subject = `[ADMIN LOG] ${event} - Claim ${claimId}`;
    const html = `
      <div style="font-family: monospace; background-color: #f4f4f5; padding: 16px; color: #18181b;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 16px; border: 1px solid #e4e4e7; border-radius: 4px;">
          <h3 style="margin-top: 0; color: #09090b; border-bottom: 2px solid #e4e4e7; padding-bottom: 8px;">RETURN4ME TRANSACTION LOG</h3>
          <pre style="margin: 16px 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap;">
EVENT:       ${event}
TIMESTAMP:   ${new Date().toISOString()}
CLAIM ID:    ${claimId}
ITEM ID:     ${itemId}
AMOUNT:      KES ${amount}
AGENT NAME:  ${agentName}
          </pre>
          <p style="font-size: 11px; color: #71717a; margin-top: 16px; border-top: 1px solid #e4e4e7; padding-top: 8px;">
            Automated internal security notification. Do not reply.
          </p>
        </div>
      </div>
    `;

  return { subject, body: html };
}

export const EmailService = {
  /**
   * Send a general email.
   *
   * RETAINED UNCHANGED as `Promise<boolean>` for backward compatibility: this is
   * the public contract every existing caller and test depends on. N9 adds
   * `sendWithId()` underneath it rather than widening this return type, because
   * changing a boolean to an object would silently break every boolean consumer.
   */
  async send(to: string, subject: string, html: string): Promise<boolean> {
    const result = await this.sendWithId(to, subject, html);
    return result.accepted;
  },

  /**
   * N9 — send and return the provider's message id.
   *
   * The Resend id was ALWAYS available here (`response.data?.id`) but was only
   * logged and discarded, which left `notification_events.provider_message_id`
   * permanently NULL for email. That matters because it is the only evidence
   * that could later resolve an AMBIGUOUS outcome — a crash between dispatch and
   * the durable `sent` update — via the Resend message-lookup API. Without the id
   * an ambiguous send is permanently unknowable.
   *
   * Returns the SAME accept/refuse decision as `send()`; there is exactly one
   * underlying Resend call, so the two cannot drift apart.
   */
  async sendWithId(
    to: string,
    subject: string,
    html: string
  ): Promise<{ accepted: boolean; providerMessageId: string | null; providerError: unknown }> {
    if (!to || to.trim() === '') {
      return { accepted: false, providerMessageId: null, providerError: null };
    }

    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const client = getResendClient();

    if (!client) {
      // No Resend client (API key missing/placeholder). In development/sandbox
      // this prints to a console outbox and returns true so dev flows work
      // without a real provider. In production there is NO simulated delivery:
      // pretending an email was sent when it was not would create false
      // operational confidence (e.g. a "payment confirmed" or "handover" email
      // the customer never received), so production FAILS CLOSED.
      if (process.env.NODE_ENV === 'production') {
        console.error('[EMAIL SERVICE] RESEND_API_KEY is not configured in production — refusing to claim the email was sent. No delivery happened.');
        return { accepted: false, providerMessageId: null, providerError: null };
      }
      console.log(`\n=================== [SANDBOX EMAIL OUTBOX] ===================`);
      console.log(`To: ${to}`);
      console.log(`From: ${fromEmail}`);
      console.log(`Subject: ${subject}`);
      console.log(`--- Body ---`);
      console.log(html);
      console.log(`==============================================================\n`);
      return { accepted: true, providerMessageId: null, providerError: null };
    }

    try {
      const response = await client.emails.send({
        from: fromEmail,
        to: to,
        subject: subject,
        html: html,
      });

      if (response.error) {
        console.error('[EMAIL SERVICE] Resend API error:', response.error);
        // The raw provider error is returned for CLASSIFICATION ONLY. It is
        // never persisted and never logged verbatim by the caller.
        return { accepted: false, providerMessageId: null, providerError: response.error };
      }

      console.log(`[EMAIL SERVICE] Email successfully sent to ${to} (ID: ${response.data?.id})`);
      return {
        accepted: true,
        providerMessageId: response.data?.id ?? null,
        providerError: null,
      };
    } catch (error) {
      console.error('[EMAIL SERVICE] Failed to send email via Resend:', error);
      // A thrown error is AMBIGUOUS: the request may or may not have been
      // accepted before the connection broke. The classifier decides what that
      // means; this layer only reports that it is unknown.
      return { accepted: false, providerMessageId: null, providerError: error };
    }
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendPaymentReceivedEmail(
    to: string,
    ownerPhone: string,
    itemName: string,
    agentBusinessName: string,
    agentPhone: string,
    itemReference: string,
    pickupCode: string
  ): Promise<boolean> {
    const rendered = renderSendPaymentReceivedEmail(to, ownerPhone, itemName, agentBusinessName, agentPhone, itemReference, pickupCode);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendItemHandedOverEmail(
    to: string,
    phone: string,
    itemName: string,
    dropoffCode: string,
    dateStr: string
  ): Promise<boolean> {
    const rendered = renderSendItemHandedOverEmail(to, phone, itemName, dropoffCode, dateStr);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAdminNewReassignmentRequestEmail(
    dropoffCode: string,
    locationDescription: string,
    finderPhone: string
  ): Promise<boolean> {
    const adminEmail = getAdminNotificationEmail();
    if (!adminEmail || adminEmail.trim() === '') {
      console.log(`[EMAIL SERVICE] Admin notification email not set. Skipping admin alert email for item ${dropoffCode}.`);
      return false;
    }

    // N8: the admin address is now resolved by the CALLER (see
    // services/adminNotification.ts). This guard is retained only so the
    // legacy wrapper's own return contract is unchanged.
    const rendered = renderSendAdminNewReassignmentRequestEmail(dropoffCode, locationDescription, finderPhone);
    return this.send(adminEmail, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAgentPaymentConfirmedEmail(
    to: string,
    agentBusinessName: string,
    itemName: string,
    dropoffCode: string,
    claimId: string
  ): Promise<boolean> {
    const rendered = renderSendAgentPaymentConfirmedEmail(to, agentBusinessName, itemName, dropoffCode, claimId);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendFinderItemCollectedEmail(
    to: string,
    itemName: string,
    dropoffCode: string
  ): Promise<boolean> {
    const rendered = renderSendFinderItemCollectedEmail(to, itemName, dropoffCode);
    return this.send(to, rendered.subject, rendered.body);
  },

  /**
   * N8 COMPATIBILITY WRAPPER - transport only. Kept so any pre-existing
   * caller keeps working unchanged. The migrated business callers use
   * NotificationService instead and do not come through here. The
   * subject/HTML live in exactly one place: the builder above.
   */
  async sendAdminTransactionLogEmail(
    event: 'PAYMENT_CONFIRMED' | 'HANDOVER_CONFIRMED' | 'HANDOVER_CONFIRMED_PENDING_SETTLEMENT',
    claimId: string,
    itemId: string,
    amount: number | string,
    agentName: string
  ): Promise<boolean> {
    const adminEmail = getAdminNotificationEmail();
    if (!adminEmail || adminEmail.trim() === '') {
      console.log(`[EMAIL SERVICE] Admin notification email not set. Skipping transaction log email for event ${event}.`);
      return false;
    }

    // N8: the admin address is now resolved by the CALLER (see
    // services/adminNotification.ts). This guard is retained only so the
    // legacy wrapper's own return contract is unchanged.
    const rendered = renderSendAdminTransactionLogEmail(event, claimId, itemId, amount, agentName);
    return this.send(adminEmail, rendered.subject, rendered.body);
  },
};