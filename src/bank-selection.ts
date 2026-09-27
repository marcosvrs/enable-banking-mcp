import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elicitFormString } from "./elicitation.js";

export interface BankCatalogClient {
  listBanks(country?: string): Promise<unknown>;
}

export type BankChoice = { name: string; country: string };

type ChoiceResult =
  | { status: "selected"; value: string }
  | { status: "unsupported" }
  | { status: "declined" }
  | { status: "invalid" };
type BankChoiceResult =
  | { status: "selected"; bank: BankChoice }
  | Exclude<ChoiceResult, { status: "selected"; value: string }>;

export type BankSelectionResult =
  | { status: "selected"; country: string; bank: BankChoice }
  | {
      status: "needs_country";
      supported_countries: string[];
      message: string;
    }
  | {
      status: "needs_bank_selection";
      banks: BankChoice[];
      country?: string;
      message: string;
    }
  | {
      status: "input_declined";
      required_input: "country" | "bank";
      supported_countries?: string[];
      banks?: BankChoice[];
      country?: string;
      message: string;
    }
  | { status: "no_banks"; country: string; message: string };

export async function resolveBankSelection(options: {
  client: BankCatalogClient;
  mcpServer: McpServer["server"];
  applicationCountries: readonly string[];
  country?: string;
  aspspName?: string;
}): Promise<BankSelectionResult> {
  let country = options.country?.trim().toUpperCase();
  const applicationCountries = normalizeCountryCodes(
    options.applicationCountries,
  );
  const applicationCountrySet = new Set(applicationCountries);
  const requestedName = options.aspspName?.trim();
  let allBanks: BankChoice[] | undefined;
  let catalogBanks: BankChoice[] | undefined;
  let selectedBank: BankChoice | undefined;

  if (!country && (requestedName || applicationCountries.length !== 1)) {
    allBanks = extractBankChoices(await options.client.listBanks());
    catalogBanks = allBanks.filter(
      (bank) =>
        /^[A-Z]{2}$/.test(bank.country) &&
        (applicationCountrySet.size === 0 ||
          applicationCountrySet.has(bank.country)),
    );
  }

  let supportedCountries = applicationCountries;
  if (catalogBanks && catalogBanks.length > 0) {
    supportedCountries = normalizeCountryCodes(
      catalogBanks.map((bank) => bank.country),
    );
  }

  if (!country && requestedName) {
    const matches = (catalogBanks ?? []).filter(
      (bank) =>
        bank.name.toLowerCase() === requestedName.toLowerCase() &&
        /^[A-Z]{2}$/.test(bank.country),
    );
    if (matches.length === 1) {
      selectedBank = matches[0];
      country = selectedBank.country;
    } else if (matches.length > 1) {
      const choice = await promptForBank(
        options.mcpServer,
        matches,
        `Enable Banking lists "${requestedName}" in multiple countries. Choose the bank and country to authorize.`,
      );
      if (choice.status !== "selected") {
        return bankSelectionRequired(matches, undefined, choice);
      }
      selectedBank = choice.bank;
      country = choice.bank.country;
    }
  }

  if (
    !country &&
    !requestedName &&
    catalogBanks?.length === 1
  ) {
    selectedBank = catalogBanks[0];
    country = selectedBank.country;
  }

  if (!country && !selectedBank) {
    if (supportedCountries.length === 1) {
      country = supportedCountries[0];
    } else {
      const choice = await promptForCountry(
        options.mcpServer,
        supportedCountries,
      );
      if (choice.status !== "selected") {
        return countrySelectionRequired(supportedCountries, choice);
      }
      country = choice.value;
    }
  }
  if (!country && selectedBank) country = selectedBank.country;
  if (!country) throw new Error("No country was selected");
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("country must be a two-letter ISO 3166-1 code");
  }
  if (
    applicationCountrySet.size > 0 &&
    !applicationCountrySet.has(country)
  ) {
    return {
      status: "needs_country",
      supported_countries: applicationCountries,
      message:
        "The country is not supported by this application. Choose a listed country and resume connect_bank.",
    };
  }

  if (!selectedBank) {
    const banks =
      catalogBanks && catalogBanks.length > 0
        ? catalogBanks.filter((bank) => bank.country === country)
        : extractBankChoices(
            await options.client.listBanks(country),
            country,
          );
    if (banks.length === 0) {
      return {
        status: "no_banks",
        country,
        message: "No personal AIS banks were returned for this country",
      };
    }

    if (requestedName) {
      selectedBank = banks.find(
        (bank) => bank.name.toLowerCase() === requestedName.toLowerCase(),
      );
      if (!selectedBank) {
        const choice = await promptForBank(
          options.mcpServer,
          banks,
          `"${requestedName}" is not an exact match for a personal AIS bank in ${country}. Choose an available bank to continue.`,
        );
        if (choice.status !== "selected") {
          return bankSelectionRequired(banks, country, choice);
        }
        selectedBank = choice.bank;
      }
    } else if (banks.length === 1) {
      selectedBank = banks[0];
    } else {
      const choice = await promptForBank(
        options.mcpServer,
        banks,
        `Choose the personal bank (ASPSP) in ${country} for read-only account access.`,
      );
      if (choice.status !== "selected") {
        return bankSelectionRequired(banks, country, choice);
      }
      selectedBank = choice.bank;
    }
  }

  if (!selectedBank) {
    throw new Error("No personal AIS bank was selected");
  }
  return { status: "selected", country, bank: selectedBank };
}

function normalizeCountryCodes(countries: readonly string[]): string[] {
  return [
    ...new Set(
      countries
        .map((country) => country.trim().toUpperCase())
        .filter((country) => /^[A-Z]{2}$/.test(country)),
    ),
  ].sort();
}

function countryChoiceTitle(country: string): string {
  const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
  return name ? `${name} (${country})` : country;
}

function extractBankChoices(
  response: unknown,
  fallbackCountry = "",
): BankChoice[] {
  if (typeof response !== "object" || response === null) return [];
  const values = (response as Record<string, unknown>).aspsps;
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const country =
      typeof record.country === "string" && record.country.trim()
        ? record.country.trim().toUpperCase()
        : fallbackCountry;
    const key = `${country}\u0000${name.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ name, country }];
  });
}

async function promptForChoice(
  mcpServer: McpServer["server"],
  field: string,
  title: string,
  message: string,
  choices: Array<{ value: string; title: string }>,
): Promise<ChoiceResult> {
  if (choices.length === 0) return { status: "invalid" };
  const result = await elicitFormString(mcpServer, field, message, {
    type: "string",
    title,
    oneOf: choices.map(({ value, title: choiceTitle }) => ({
      const: value,
      title: choiceTitle,
    })),
  });
  if (result.status !== "accepted") {
    return result.status === "declined"
      ? { status: "declined" }
      : result;
  }
  return choices.some((choice) => choice.value === result.value)
    ? { status: "selected", value: result.value }
    : { status: "invalid" };
}

async function promptForCountry(
  mcpServer: McpServer["server"],
  supportedCountries: string[],
): Promise<ChoiceResult> {
  if (supportedCountries.length > 0) {
    return promptForChoice(
      mcpServer,
      "country",
      "Country",
      "Choose the country where your personal bank account is held.",
      supportedCountries.map((country) => ({
        value: country,
        title: countryChoiceTitle(country),
      })),
    );
  }

  const result = await elicitFormString(
    mcpServer,
    "country",
    "Enter the two-letter country code where your personal bank account is held.",
    {
      type: "string",
      title: "Country code",
      minLength: 2,
      maxLength: 2,
    },
  );
  if (result.status !== "accepted") {
    return result.status === "declined"
      ? { status: "declined" }
      : result;
  }
  const country = result.value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country)
    ? { status: "selected", value: country }
    : { status: "invalid" };
}

async function promptForBank(
  mcpServer: McpServer["server"],
  banks: BankChoice[],
  message: string,
): Promise<BankChoiceResult> {
  const choices = banks.map((bank, index) => ({
    value: String(index),
    title: bank.country ? `${bank.name} (${bank.country})` : bank.name,
  }));
  const result = await promptForChoice(
    mcpServer,
    "bank",
    "Bank",
    message,
    choices,
  );
  if (result.status !== "selected") return result;
  const index = Number(result.value);
  const bank = Number.isInteger(index) ? banks[index] : undefined;
  return bank ? { status: "selected", bank } : { status: "invalid" };
}

function countrySelectionRequired(
  countries: string[],
  result: ChoiceResult,
): BankSelectionResult {
  if (result.status === "declined") {
    return {
      status: "input_declined",
      required_input: "country",
      supported_countries: countries,
      message:
        "Country selection was declined; no bank authorization started. Resume connect_bank when ready.",
    };
  }
  return {
    status: "needs_country",
    supported_countries: countries,
    message:
      result.status === "unsupported"
        ? countries.length > 0
          ? "This MCP client does not support form elicitation. Ask the user to choose a supported country from this list, then call connect_bank with its two-letter code."
          : "This MCP client does not support form elicitation. Ask the user for the two-letter country code where the bank account is held, then resume connect_bank."
        : "A valid supported country code is required. Ask the user to choose from supported_countries, then resume connect_bank.",
  };
}

function bankSelectionRequired(
  banks: BankChoice[],
  country: string | undefined,
  result: BankChoiceResult,
): BankSelectionResult {
  if (result.status === "declined") {
    return {
      status: "input_declined",
      required_input: "bank",
      ...(country ? { country } : {}),
      banks,
      message:
        "Bank selection was declined; no bank authorization started. Resume connect_bank when ready.",
    };
  }
  return {
    status: "needs_bank_selection",
    ...(country ? { country } : {}),
    banks,
    message:
      result.status === "unsupported"
        ? "This MCP client does not support form elicitation. Ask the user to choose a bank from the provider-listed options, then resume connect_bank with the selected bank and country."
        : "A valid provider-listed bank choice is required. Ask the user to choose from banks, then resume connect_bank.",
  };
}
