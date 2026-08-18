import { LightningElement, api } from 'lwc';
import getFormDefinition from '@salesforce/apex/FormMasterController.getFormDefinition';
import submitFormResponses from '@salesforce/apex/FormMasterController.submitFormResponses';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

export default class DynamicFormRenderer extends LightningElement {
    @api programName;

    pages = [];
    answers = {};
    isLoading = true;
    isSubmitted = false;
    errorMessage;
    activePageId;
    submissionToken;

    connectedCallback() {
        this.submissionToken = this.generateSubmissionToken();
        this.fetchFormDefinition();
    }

    fetchFormDefinition() {
        getFormDefinition({
            programName: this.programName
        })
            .then(data => {
                this.buildHierarchy(data);
                this.evaluateLogic();

                if (this.pages.length) {
                    this.activePageId = this.pages[0].id;
                    this.updatePageVisibility();
                }

                this.isLoading = false;
            })
            .catch(error => {
                this.errorMessage =
                    error?.body?.message ||
                    error?.message ||
                    'Unable to load the form.';

                this.isLoading = false;
            });
    }

    decodeHtmlEntities(value) {
        if (!value) {
            return '';
        }

        return String(value)
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&');
    }

    buildHierarchy(elements) {
        const pageMap = new Map();
        const sectionMap = new Map();

        elements.forEach(element => {
            if (element.dataType !== 'Section') {
                return;
            }

            if (!pageMap.has(element.pageId)) {
                pageMap.set(element.pageId, {
                    id: element.pageId,
                    name: element.pageName || 'Untitled Page',
                    order: element.pageOrder || 0,
                    sections: [],
                    isDeadEnd: false,
                    isVisible: true
                });
            }

            const layoutClass =
                element.layout === '2 Columns'
                    ? 'slds-col slds-size_1-of-1 slds-medium-size_1-of-2 slds-p-horizontal_small'
                    : 'slds-col slds-size_1-of-1 slds-p-horizontal_small';

            const section = {
                ...element,
                elements: [],
                isVisible: !element.parentId,
                layoutClass
            };

            sectionMap.set(element.id, section);
            pageMap.get(element.pageId).sections.push(section);
        });

        elements.forEach(element => {
            if (
                element.dataType === 'Section' ||
                !element.sectionId ||
                !sectionMap.has(element.sectionId)
            ) {
                return;
            }

            const section = sectionMap.get(element.sectionId);
            const isPicklist =
                element.dataType?.toLowerCase() === 'picklist';
            const isCheckbox =
                element.dataType === 'Checkbox';

            const helpText = this.decodeHtmlEntities(
                element.richText || ''
            );

            section.elements.push({
                ...element,
                isVisible: !element.parentId,
                value: isCheckbox ? false : '',
                options: Array.isArray(element.choices)
                    ? element.choices
                    : [],
                helpText,
                hasHelpText: helpText !== '',
                required: element.required === true,
                isInfo: element.dataType === 'Info',
                isText:
                    element.dataType === 'Text' ||
                    element.dataType === 'Additional Q',
                isTextArea: element.dataType === 'Text Area',
                isPicklist,
                isDate: element.dataType === 'Date',
                isCheckbox
            });
        });

        pageMap.forEach(page => {
            page.sections.sort(
                (a, b) => (a.order || 0) - (b.order || 0)
            );

            page.sections.forEach(section => {
                section.elements.sort(
                    (a, b) =>
                        (a.sortOrder || 0) -
                        (b.sortOrder || 0)
                );
            });
        });

        this.pages = Array.from(pageMap.values())
            .sort(
                (a, b) =>
                    (a.order || 0) -
                    (b.order || 0)
            )
            .map((page, index, pages) => ({
                ...page,
                index,
                isCurrentPage: index === 0,
                hasPrevPage: index > 0,
                hasNextPage: index < pages.length - 1
            }));
    }

    updatePageVisibility() {
        this.pages.forEach(page => {
            page.isCurrentPage =
                page.id === this.activePageId;
        });

        this.pages = [...this.pages];
    }

    handleChange(event) {
        const fieldId = event.target.dataset.id;
        this.answers[fieldId] = event.detail.value;
        this.evaluateLogic();
    }

    handleCheckboxChange(event) {
        const fieldId = event.target.dataset.id;
        this.answers[fieldId] = event.target.checked;
        this.evaluateLogic();
    }

    checkVisibility(parentId, showWhenArray) {
        const rawValue =
            this.getNormalizedAnswer(parentId);

        if (!rawValue) {
            return false;
        }

        const parentValues = rawValue
            .split(';')
            .map(value => value.trim())
            .filter(Boolean);

        const showWhen = (showWhenArray || [])
            .map(value =>
                String(value)
                    .trim()
                    .toLowerCase()
            );

        return parentValues.some(value =>
            showWhen.includes(value)
        );
    }

    evaluateLogic() {
        let deadEndReached = false;

        this.pages.forEach(page => {
            page.isDeadEnd = false;

            if (deadEndReached) {
                page.isVisible = false;

                page.sections.forEach(section => {
                    section.isVisible = false;
                    this.clearSectionAnswers(section);
                });

                return;
            }

            let pageHasVisibleSections = false;
            let pageHasDeadEnd = false;

            page.sections.forEach(section => {
                if (section.parentId) {
                    section.isVisible =
                        this.checkVisibility(
                            section.parentId,
                            section.showWhen
                        );

                    if (!section.isVisible) {
                        this.clearSectionAnswers(section);
                    }
                } else {
                    section.isVisible = true;
                }

                if (!section.isVisible) {
                    return;
                }

                let sectionHasVisibleElements = false;

                section.elements.forEach(element => {
                    if (element.parentId) {
                        element.isVisible =
                            this.checkVisibility(
                                element.parentId,
                                element.showWhen
                            );

                        if (!element.isVisible) {
                            delete this.answers[element.id];
                            element.value =
                                element.isCheckbox
                                    ? false
                                    : '';
                        }
                    } else {
                        element.isVisible = true;
                    }

                    if (element.isVisible) {
                        if (
                            this.answers[element.id] !==
                            undefined
                        ) {
                            element.value =
                                this.answers[element.id];
                        }

                        sectionHasVisibleElements = true;

                        if (element.terminal === true) {
                            pageHasDeadEnd = true;
                        }
                    }
                });

                section.isVisible =
                    sectionHasVisibleElements;

                if (section.isVisible) {
                    pageHasVisibleSections = true;
                }
            });

            page.isVisible =
                pageHasVisibleSections;

            if (pageHasDeadEnd) {
                page.isDeadEnd = true;
                deadEndReached = true;
            }
        });

        const visiblePages =
            this.pages.filter(
                page => page.isVisible
            );

        visiblePages.forEach((page, index) => {
            page.hasPrevPage = index > 0;
            page.hasNextPage =
                !page.isDeadEnd &&
                index < visiblePages.length - 1;
        });

        if (
            this.activePageId &&
            !visiblePages.some(
                page => page.id === this.activePageId
            )
        ) {
            this.activePageId =
                visiblePages.length
                    ? visiblePages[
                          visiblePages.length - 1
                      ].id
                    : null;
        }

        this.pages = [...this.pages];
    }

    getNormalizedAnswer(fieldId) {
        const value = this.answers[fieldId];

        if (
            value === undefined ||
            value === null ||
            value === ''
        ) {
            return '';
        }

        return String(value)
            .trim()
            .toLowerCase();
    }

    clearSectionAnswers(section) {
        section.elements.forEach(element => {
            delete this.answers[element.id];
            element.value =
                element.isCheckbox
                    ? false
                    : '';
        });
    }

    validateCurrentPage() {
        const inputs = [
            ...this.template.querySelectorAll(
                'lightning-input, lightning-textarea, lightning-combobox'
            )
        ];

        return inputs.every(input => {
            const valid =
                input.checkValidity();

            if (!valid) {
                input.reportValidity();
            }

            return valid;
        });
    }

    handleNext() {
        if (!this.validateCurrentPage()) {
            return;
        }

        const visiblePages =
            this.pages.filter(
                page => page.isVisible
            );

        const currentIndex =
            visiblePages.findIndex(
                page => page.id === this.activePageId
            );

        if (
            currentIndex >= 0 &&
            currentIndex <
                visiblePages.length - 1
        ) {
            this.activePageId =
                visiblePages[
                    currentIndex + 1
                ].id;

            this.updatePageVisibility();
            this.scrollToTop();
        }
    }

    handlePrevious() {
        const visiblePages =
            this.pages.filter(
                page => page.isVisible
            );

        const currentIndex =
            visiblePages.findIndex(
                page => page.id === this.activePageId
            );

        if (currentIndex > 0) {
            this.activePageId =
                visiblePages[
                    currentIndex - 1
                ].id;

            this.updatePageVisibility();
            this.scrollToTop();
        }
    }

    handleSubmit() {
        if (!this.validateCurrentPage()) {
            return;
        }

        this.isLoading = true;
        this.errorMessage = undefined;

        const submissionData = {};

        this.pages.forEach(page => {
            if (!page.isVisible) {
                return;
            }

            page.sections.forEach(section => {
                if (!section.isVisible) {
                    return;
                }

                section.elements.forEach(element => {
                    if (
                        element.isVisible &&
                        element.id &&
                        element.value !== undefined &&
                        element.value !== null &&
                        element.value !== ''
                    ) {
                        submissionData[element.id] =
                            element.value;
                    }
                });
            });
        });

        if (!this.submissionToken) {
            this.submissionToken =
                this.generateSubmissionToken();
        }

        submitFormResponses({
            programName:
                this.programName,
            formTitle:
                this.programName ||
                'Untitled Form',
            submissionToken:
                this.submissionToken,
            formResponsesJson:
                JSON.stringify(
                    submissionData
                )
        })
            .then(() => {
                this.isLoading = false;
                this.isSubmitted = true;
            })
            .catch(error => {
                this.isLoading = false;

                this.errorMessage =
                    error?.body?.message ||
                    'Unable to submit the form. Please try again.';

                this.dispatchEvent(
                    new ShowToastEvent({
                        title:
                            'Submission failed',
                        message:
                            this.errorMessage,
                        variant: 'error'
                    })
                );
            });
    }

    generateSubmissionToken() {
        if (
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID ===
                'function'
        ) {
            return crypto.randomUUID();
        }

        return (
            Date.now().toString(36) +
            '-' +
            Math.random()
                .toString(36)
                .substring(2, 15)
        );
    }

    scrollToTop() {
        const formTop =
            this.template.querySelector(
                '.form-canvas'
            );

        if (formTop) {
            formTop.scrollIntoView({
                behavior: 'smooth'
            });
        }
    }

    handleResetForm() {
        this.isSubmitted = false;
        this.errorMessage = undefined;
        this.answers = {};
        this.submissionToken =
            this.generateSubmissionToken();
        this.isLoading = true;
        this.fetchFormDefinition();
    }
}