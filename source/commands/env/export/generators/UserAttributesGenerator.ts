import { Permit } from 'permitio';
import { HCLGenerator, WarningCollector } from '../types.js';
import Handlebars, { TemplateDelegate } from 'handlebars';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// built-in attributes that should be excluded from export
const BUILTIN_USER_ATTRIBUTES = [
	'key',
	'roles',
	'email',
	'first_name',
	'last_name',
];

interface UserAttributeData {
	resourceKey: string;
	key: string;
	type: string;
	description: string;
}

export class UserAttributesGenerator implements HCLGenerator {
	name = 'user attribute';
	private template: TemplateDelegate<{ attributes: UserAttributeData[] }>;

	constructor(
		private permit: Permit,
		private warningCollector: WarningCollector,
	) {
		// Register a simple helper that creates extremely safe descriptions for HCL
		Handlebars.registerHelper('formatDescription', function (text) {
			if (!text) return '';

			// First, normalize the string to remove any non-basic characters
			const sanitized = text
				// Replace non-alphanumeric, non-basic punctuation with spaces
				.replace(/[^\w\s.,!?()-]/g, ' ')
				// Collapse multiple spaces into one
				.replace(/\s+/g, ' ')
				// Trim spaces
				.trim();

			return sanitized;
		});

		this.template = this.loadTemplate();
	}

	private loadTemplate(): TemplateDelegate<{
		attributes: UserAttributeData[];
	}> {
		try {
			const templatePath = join(__dirname, '../templates/user-attribute.hcl');
			const templateContent = readFileSync(templatePath, 'utf-8');
			if (!templateContent) {
				throw new Error('Template content is empty');
			}
			return Handlebars.compile(templateContent, { noEscape: true });
		} catch (error) {
			throw new Error(
				`Failed to load user attribute template: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async getUserAttributes(): Promise<UserAttributeData[]> {
		try {
			const userResource = await this.permit.api.resources.get('__user');
			if (!userResource?.attributes) {
				return [];
			}

			return (
				Object.entries(userResource.attributes)
					// Filter out built-in attributes by key
					.filter(([key]) => !BUILTIN_USER_ATTRIBUTES.includes(key))
					// Additional filtering by description for extra safety
					.filter(([, attr]) => {
						const description = attr.description?.toLowerCase() || '';
						return (
							!description.includes('built in attribute') &&
							!description.includes('built-in attribute')
						);
					})
					.map(([key, attr]) => ({
						resourceKey: this.generateResourceKey(key),
						key,
						type: this.normalizeAttributeType(attr.type),
						description: attr.description || '',
					}))
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.warningCollector.addWarning(
				`Error fetching user attributes: ${errorMessage}`,
			);
			throw error;
		}
	}

	private generateResourceKey(key: string): string {
		return `user_${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
	}

	private normalizeAttributeType(type: string): string {
		const typeMap: Record<string, string> = {
			string: 'string',
			number: 'number',
			boolean: 'bool',
			bool: 'bool',
			array: 'array',
			object: 'json',
			json: 'json',
			time: 'string',
		};
		const normalizedType = typeMap[type.toLowerCase()];
		if (!normalizedType) {
			this.warningCollector.addWarning(
				`Unknown attribute type: ${type}, using 'string' as default`,
			);
			return 'string';
		}
		return normalizedType;
	}

	async generateHCL(): Promise<string> {
		try {
			const attributes = await this.getUserAttributes();
			if (attributes.length === 0) {
				return '';
			}
			const header = '\n# User Attributes\n';
			const content = this.template({ attributes });
			if (!content.trim()) {
				throw new Error('Generated HCL content is empty');
			}
			return header + content;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.warningCollector.addWarning(
				`Failed to export user attributes: ${errorMessage}`,
			);
			return '';
		}
	}
}
