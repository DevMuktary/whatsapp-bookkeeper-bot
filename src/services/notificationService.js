import * as Brevo from '@getbrevo/brevo';

// --- Initialize Brevo API client ---
const defaultClient = Brevo.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new Brevo.TransactionalEmailsApi();

// --- Configure your sender details ---
const SENDER_EMAIL = 'no-reply@fynaxtech.com';
const SENDER_NAME = 'Fynax Bookkeeper';

/**
 * Sends a beautiful HTML email with an OTP for verification.
 */
export async function sendOtpEmail(userEmail, otp, businessName) {
    if (!process.env.BREVO_API_KEY) {
        console.error("Brevo API key is not set. Cannot send email.");
        return false;
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f7fafc; }
            .container { max-width: 600px; margin: 40px auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
            .header { background-color: #001232; color: #ffffff; padding: 20px; text-align: center; }
            .header h1 { margin: 0; font-size: 24px; color: #ffffff !important; }
            .content { padding: 30px; color: #2d3748; line-height: 1.7; }
            .content p { margin-bottom: 20px; }
            .otp-code { background-color: #f7fafc; border: 1px dashed #e2e8f0; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
            .otp-code h2 { font-size: 36px; margin: 0; color: #0052cc; letter-spacing: 4px; }
            .footer { background-color: #f7fafc; padding: 20px; text-align: center; font-size: 12px; color: #5a677b; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Fynax Bookkeeper</h1>
            </div>
            <div class="content">
                <p>Hello,</p>
                <p>Here is your one-time verification code for your business, <strong>${businessName}</strong>. Please send this code back to the Fynax Bookkeeper on WhatsApp to verify your email address.</p>
                <div class="otp-code">
                    <h2>${otp}</h2>
                </div>
                <p>If you did not request this code, you can safely ignore this email.</p>
                <p>Thank you,<br>The Fynax Team</p>
            </div>
            <div class="footer">
                &copy; ${new Date().getFullYear()} Fynax Technology Concepts. All rights reserved.
            </div>
        </div>
    </body>
    </html>
    `;

    try {
        console.log("Attempting to send email via Brevo...");
        // Capture the response from the API call
        const response = await apiInstance.sendTransacEmail({
            sender: { email: SENDER_EMAIL, name: SENDER_NAME },
            to: [{ email: userEmail }],
            subject: `Your Fynax Bookkeeper Verification Code is ${otp}`,
            htmlContent: htmlContent,
        });

        // --- NEW DEBUGGING LOG ---
        // This will print the full response from Brevo to the logs.
        console.log("Brevo API Response:", JSON.stringify(response, null, 2));
        // --- END DEBUGGING LOG ---

        console.log(`OTP email sent successfully to ${userEmail}`);
        return true;

    } catch (error) {
        // --- NEW DEBUGGING LOG ---
        // This will print the full error object if the call fails.
        console.error("Full error object from Brevo:", JSON.stringify(error, null, 2));
        // --- END DEBUGGING LOG ---
        
        console.error("Error sending OTP email via Brevo:", error.body || error.message);
        return false;
    }
}
