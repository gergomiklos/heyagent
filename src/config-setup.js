import prompts from 'prompts';
import { v4 as uuidv4 } from 'uuid';
import qrcode from 'qrcode-terminal';
import { isPaidNotificationMethod, validateKeyClientSide, getCheckoutUrl } from './license.js';
import Logger from './logger.js';

class ConfigSetup {
  constructor(config) {
    this.config = config;
    this.logger = new Logger('config-setup');
  }

  async runSetupWizard() {
    const currentMethod = this.config.notificationMethod;
    await this.setupWizard();
    await this.licenseWizard(currentMethod, this.config.notificationMethod);
    return this.config.data;
  }

  async runConfigWizard() {
    const currentMethod = this.config.notificationMethod;
    await this.setupWizard(true);
    await this.licenseWizard(currentMethod, this.config.notificationMethod);
    return this.config.data;
  }

  async runLicenseWizard() {
    const currentKey = this.config.licenseKey;

    if (currentKey) {
      const { valid, reason } = await validateKeyClientSide(currentKey, this.logger);
      if (valid) {
        console.log('Current license is valid');
      } else {
        console.log(`Current license is invalid: ${reason}`);
      }
    } else {
      console.log('No license key found');
    }

    const action = await prompts({
      type: 'select',
      name: 'action',
      message: 'Choose an option:',
      choices: [
        ...(currentKey ? [{ title: 'Keep Current License', value: 'keep' }] : []),
        { title: 'Update License Key', value: 'update' },
        { title: 'Buy New Pro License', value: 'buy' },
        ...(currentKey ? [{ title: 'Open Customer Portal', value: 'portal' }] : []),
        ...(currentKey ? [{ title: 'Remove License', value: 'remove' }] : []),
      ],
    });

    if (!action.action || action.action === 'keep') {
      console.log('No changes made');
      return;
    }

    if (action.action === 'remove') {
      this.config.clearLicenseKey();
      console.log('License key removed');
      return;
    }

    if (action.action === 'update') {
      const success = await this.promptForLicenseKey();
      if (!success) {
        console.log('License update cancelled');
      }
      return;
    }

    if (action.action === 'buy') {
      await this.buyNewLicense();
      return;
    }

    if (action.action === 'portal') {
      console.log('\nCustomer Portal:');
      console.log('Go to: https://polar.sh/heyagent/portal');
      console.log('Use your email address to access your account and manage your license.');
      return;
    }
  }

  async setupWizard(configMode = false) {
    const isFirstRun = this.config.isFirstRun;
    const choices = this.getOrderedNotificationChoices();

    const response = await prompts({
      type: 'select',
      name: 'notificationMethod',
      message: 'Select notification method:',
      choices: choices,
    });

    if (!response.notificationMethod) return this.config.data;

    const selectedMethod = response.notificationMethod;

    if (selectedMethod === 'disabled') {
      this.config.save({ notificationsEnabled: false });
      return this.config.data;
    } else {
      response.notificationsEnabled = true;
    }

    const needsSetup = configMode || !this.config.validateConfig(selectedMethod);

    if (needsSetup) {
      if (selectedMethod === 'email') {
        const emailData = await this.setupEmail();
        Object.assign(response, emailData);
      }

      if (selectedMethod === 'whatsapp') {
        const phoneData = await this.setupWhatsapp();
        Object.assign(response, phoneData);
      }

      if (selectedMethod === 'telegram') {
        const telegramData = await this.setupTelegram();
        Object.assign(response, telegramData);
      }

      if (selectedMethod === 'slack') {
        const slackData = await this.setupSlack();
        Object.assign(response, slackData);
      }

      if (selectedMethod === 'webhook') {
        const webhookData = await this.setupWebhook();
        Object.assign(response, webhookData);
      }
    }

    this.config.save(response);

    if (isFirstRun || needsSetup) {
      // Confirmattion message
      console.log(`\nNotification method set to: ${response.notificationMethod}`);
      if (response.email) console.log(`Email: ${response.email}`);
      if (response.phoneNumber) console.log(`Phone: ${response.phoneNumber}`);
      if (response.telegramChatId) console.log(`Telegram: ${response.telegramChatId}`);
      if (response.slackWebhookUrl) console.log(`Slack: ${response.slackWebhookUrl}`);
      if (response.slackUsername) console.log(`Slack Username: ${response.slackUsername}`);
      if (response.webhookUrl) console.log(`Webhook: ${response.webhookUrl}`);
      console.log(`Settings saved\n`);
    }

    if (response.notificationMethod === 'desktop' && process.platform === 'darwin') {
      console.log(`If notifications don't appear, enable permissions in System Settings → Notifications → [Your Terminal App]`);
    }

    return this.config.data;
  }

  async licenseWizard(previousMethod, selectedMethod) {
    if (isPaidNotificationMethod(selectedMethod)) {
      const license = await this.ensureLicense();
      if (!license) {
        this.config.data.notificationMethod = previousMethod;
        await this.setupWizard();
      }
    }
  }

  getOrderedNotificationChoices() {
    const currentMethod = this.config.get('notificationMethod');
    const allMethods = [
      { value: 'desktop', title: 'Desktop Notification   (Free)', needsConfig: false },
      { value: 'email', title: 'Email                  (Pro)', needsConfig: true, configKey: 'email' },
      { value: 'telegram', title: 'Telegram               (Pro)', needsConfig: true, configKey: 'telegramChatId' },
      { value: 'slack', title: 'Slack                  (Pro)', needsConfig: true, configKey: 'slackWebhookUrl' },
      { value: 'webhook', title: 'Webhook                (Free)', needsConfig: true, configKey: 'webhookUrl' },
      { value: 'disabled', title: 'Disabled               (Off)', needsConfig: false },
    ];

    const currentChoice = allMethods.find(m => m.value === currentMethod);
    const desktopChoice = allMethods.find(m => m.value === 'desktop');
    const configuredChoices = allMethods.filter(
      m => m.value !== currentMethod && m.value !== 'desktop' && (!m.needsConfig || this.config.get(m.configKey))
    );
    const unconfiguredChoices = allMethods.filter(
      m => m.value !== currentMethod && m.value !== 'desktop' && m.needsConfig && !this.config.get(m.configKey)
    );

    const orderedChoices = [];
    if (currentChoice) orderedChoices.push(currentChoice);
    if (currentMethod !== 'desktop') orderedChoices.push(desktopChoice);
    orderedChoices.push(...configuredChoices);
    orderedChoices.push(...unconfiguredChoices);

    return orderedChoices.map(choice => ({
      title: choice.title + (choice.value === currentMethod ? ' (last used)' : ''),
      value: choice.value,
    }));
  }

  async setupEmail() {
    const currentEmail = this.config.get('email');
    const response = await prompts({
      type: 'text',
      name: 'email',
      message: 'Enter your email address:',
      initial: currentEmail || '',
      validate: this.validateEmail.bind(this),
    });
    return { email: response.email };
  }

  async setupWhatsapp() {
    const currentPhone = this.config.get('phoneNumber');
    const response = await prompts({
      type: 'text',
      name: 'phoneNumber',
      message: 'Enter your phone number for WhatsApp (include country code, e.g. +1234567890):',
      initial: currentPhone || '',
      validate: this.validatePhone.bind(this),
    });
    return { phoneNumber: response.phoneNumber };
  }

  async setupSlack() {
    const currentUrl = this.config.get('slackWebhookUrl');
    const currentUsername = this.config.get('slackUsername');

    if (!currentUrl) {
      console.log('\nTo create a Slack webhook:');
      console.log('1. Go to https://slack.com/apps/A0F7XDUAZ-incoming-webhooks');
      console.log('2. Click "Add to Slack"');
      console.log('3. Choose your channel and click "Add Incoming WebHooks Integration"');
      console.log('4. Copy the webhook URL and paste it below');
    }

    const webhookResponse = await prompts({
      type: 'text',
      name: 'slackWebhookUrl',
      message: 'Enter your Slack webhook URL:',
      initial: currentUrl || '',
      validate: this.validateSlackUrl.bind(this),
    });

    if (!webhookResponse.slackWebhookUrl) return {};

    const usernameResponse = await prompts({
      type: 'text',
      name: 'slackUsername',
      message: 'Enter your Slack username (e.g., @john or john):',
      initial: currentUsername || '',
      validate: this.validateSlackUsername.bind(this),
    });

    return {
      slackWebhookUrl: webhookResponse.slackWebhookUrl,
      slackUsername: usernameResponse.slackUsername,
    };
  }

  async setupWebhook() {
    const currentUrl = this.config.get('webhookUrl');
    const response = await prompts({
      type: 'text',
      name: 'webhookUrl',
      message: 'Enter your webhook URL:',
      initial: currentUrl || '',
      validate: this.validateUrl.bind(this),
    });
    return { webhookUrl: response.webhookUrl };
  }

  async setupTelegram() {
    const token = uuidv4().substring(0, 8).toUpperCase();
    const telegramUrl = `https://t.me/HeyAgent_bot?start=${token}`;

    console.log('\nTelegram Setup');
    console.log('Follow these steps to connect your Telegram:');
    console.log('1. Scan this QR code with your phone:');

    qrcode.generate(telegramUrl, { small: true });

    console.log('2. OR click this link:');
    console.log(`   ${telegramUrl}`);
    console.log('3. Click "START" in the Telegram bot');
    console.log('\nWaiting for you to start the bot...\n');

    const maxAttempts = 60;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        const response = await fetch(`https://www.heyagent.dev/api/telegram/poll/${token}`);
        const data = await response.json();

        if (data.chatId) {
          console.log('Telegram connected successfully!');
          return { telegramChatId: data.chatId };
        }
      } catch (error) {
        if (attempts === 0) {
          console.error('Error connecting to server.');
          throw error;
        }
      } finally {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;
      }
    }

    throw new Error('Timeout: Please try again and make sure to start the bot within 5 minutes');
  }

  async ensureLicense() {
    // Check if we already have a valid license
    if (this.config.licenseKey) {
      const { valid, reason } = await validateKeyClientSide(this.config.licenseKey, this.logger);
      if (valid) {
        return true;
      }
      // Clear invalid license
      console.log(`Invalid license found. Reason: ${reason}`);
      this.config.clearLicenseKey();
    }

    console.log('\nPro notifications require a license.');

    const action = await prompts({
      type: 'select',
      name: 'action',
      message: 'Choose an option:',
      choices: [
        { title: 'Paste Existing License Key', value: 'paste' },
        { title: 'Buy New Pro License', value: 'buy' },
        { title: 'Cancel', value: 'cancel' },
      ],
    });

    if (action.action === 'paste') {
      return await this.promptForLicenseKey();
    } else if (action.action === 'buy') {
      return await this.buyNewLicense();
    } else if (action.action === 'cancel') {
      console.log('License setup cancelled. Using free notifications only.');
      return false;
    }
  }

  async buyNewLicense() {
    const checkoutUrl = await getCheckoutUrl(this.logger);
    console.log('To purchase a Pro license, visit:');
    console.log(checkoutUrl);
    console.log('Complete your purchase, then copy your license key and paste it here.');
    const success = await this.promptForLicenseKey();
    if (!success) {
      console.log('License setup cancelled');
    }
    return success;
  }

  async promptForLicenseKey() {
    let attempts = -1;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      attempts++;

      const keyResponse = await prompts({
        type: 'text',
        name: 'key',
        message: 'Paste license key:',
      });

      if (!keyResponse.key) {
        console.log('License key is required for Pro features.');
        return false;
      }

      console.log('Validating license key...');
      const { valid, reason } = await validateKeyClientSide(keyResponse.key, this.logger);

      if (valid) {
        this.config.set('licenseKey', keyResponse.key);
        console.log('License saved.');
        return true;
      } else {
        console.log("The provided key isn't valid for this product. Check and paste again.");
        console.log(`Reason: ${reason}`);
      }
    }
    return false;
  }

  validateEmail(email) {
    return email.includes('@') ? true : 'Please enter a valid email address';
  }

  validateUrl(url) {
    try {
      new URL(url);
      return true;
    } catch {
      return 'Please enter a valid URL (e.g., https://example.com/webhook)';
    }
  }

  validateSlackUrl(url) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === 'hooks.slack.com' && parsedUrl.pathname.startsWith('/services/')) {
        return true;
      }
      return 'Please enter a valid Slack webhook URL (https://hooks.slack.com/services/...)';
    } catch {
      return 'Please enter a valid Slack webhook URL';
    }
  }

  validatePhone(phone) {
    return phone.startsWith('+') && phone.length >= 10 ? true : 'Please enter a valid phone number with country code';
  }

  validateSlackUsername(username) {
    if (!username) return 'Username is required';
    const cleanUsername = username.startsWith('@') ? username.slice(1) : username;
    return cleanUsername.length > 0 ? true : 'Please enter a valid Slack username';
  }
}

export default ConfigSetup;
