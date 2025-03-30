import React, { useState, useCallback, useEffect } from 'react';
import {
	getFiles,
	ApplyTemplate,
	ApplyTemplateLocally,
} from '../../../lib/env/template/utils.js';
import SelectInput from 'ink-select-input';
import { Text } from 'ink';
import Spinner from 'ink-spinner'; // Import Spinner
import { useAuth } from '../../AuthProvider.js';

type Props = {
	local?: boolean;
	template?: string;
};

type SelectItemType = {
	label: string;
	value: string;
};

export default function ApplyComponent({ local, template }: Props) {
	const [errorMessage, setErrorMessage] = useState('');
	const [successMessage, setSuccessMessage] = useState('');
	const [isLoading, setIsLoading] = useState(false);
	const files = getFiles();
	const { authToken: key } = useAuth();

	const selectionValues = files.map(file => ({
		label: file,
		value: file,
	}));

	// Memoized function to apply template
	const applyTemplate = useCallback(
		async (selectedTemplate: string) => {
			setIsLoading(true);

			try {
				const message = local
					? await ApplyTemplateLocally(selectedTemplate, key)
					: await ApplyTemplate(selectedTemplate, key);

				if (message.startsWith('Error')) {
					setErrorMessage(message);
				} else {
					setSuccessMessage(message);
				}
			} catch (error) {
				setErrorMessage(error instanceof Error ? error.message : String(error));
			} finally {
				setIsLoading(false);
			}
		},
		[local, key],
	); // Dependencies ensure function remains stable

	// If a template is passed as a prop, apply it once
	useEffect(() => {
		if (template) {
			applyTemplate(template);
		}
	}, [template, applyTemplate]); // Ensures function isn't recreated unnecessarily

	// Handle user selection from SelectInput
	const handleSelect = async (item: SelectItemType) => {
		setIsLoading(true);
		await applyTemplate(item.value);
	};

	return (
		<>
			{isLoading ? (
				<Text color="cyan">
					<Spinner type="dots" /> Applying template...
				</Text>
			) : errorMessage ? (
				<Text color="red">{errorMessage}</Text>
			) : successMessage ? (
				<Text color="green">{successMessage}</Text>
			) : !template ? (
				<>
					<Text>Select Template </Text>
					<SelectInput items={selectionValues} onSelect={handleSelect} />
				</>
			) : null}
		</>
	);
}
