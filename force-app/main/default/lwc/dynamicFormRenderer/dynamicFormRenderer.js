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

    nodeById = new Map();
    childrenByParentId = new Map();

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

                if (this.pages.length > 0) {
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

        this.nodeById = new Map();
        this.childrenByParentId = new Map();

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
            this.nodeById.set(element.id, section);
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
                element.richText || element.helpText || ''
            );

            const child = {
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
                isCheckbox,
                isFileUpload: element.dataType === 'File Upload'
            };

            section.elements.push(child);
            this.nodeById.set(child.id, child);

            if (child.parentId) {
                if (!this.childrenByParentId.has(child.parentId)) {
                    this.childrenByParentId.set(child.parentId, []);
                }

                this.childrenByParentId
                    .get(child.parentId)
                    .push(child);
            }
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
        const rawValue = this.getNormalizedAnswer(parentId);

        if (rawValue === '') {
            return false;
        }

        // Split by semicolon to correctly evaluate Multi-Select Picklists
        const parentValues = rawValue
            .split(';')
            .map(v => v.trim())
            .filter(Boolean);

        const showWhen = (showWhenArray || [])
            .map(v => String(v).trim().toLowerCase());

        return parentValues.some(val =>
            showWhen.includes(val)
        );
    }

    evaluateLogic() {
    let isDeadEndReached = false;

    this.pages.forEach(page => {
        page.isDeadEnd = false;

        if (isDeadEndReached) {
            page.isVisible = false;

            page.sections.forEach(sec => {
                sec.isVisible = false;
                this.clearSectionAnswers(sec);
            });

            return;
        }

        let pageHasVisibleSections = false;
        let pageHasDeadEnd = false;

        page.sections.forEach(sec => {
            /*
             * Section conditional logic.
             */
            if (sec.parentId) {
                const rawParentVal =
                    this.answers[sec.parentId];

                const parentVal =
                    rawParentVal
                        ? String(rawParentVal)
                              .trim()
                              .toLowerCase()
                        : '';

                const normalizedShowWhen =
                    (sec.showWhen || [])
                        .map(v =>
                            String(v)
                                .trim()
                                .toLowerCase()
                        );

                sec.isVisible =
                    Boolean(parentVal) &&
                    normalizedShowWhen.includes(
                        parentVal
                    );

                if (!sec.isVisible) {
                    this.clearSectionAnswers(sec);
                }
            } else {
                sec.isVisible = true;
            }

            if (!sec.isVisible) {
                return;
            }

            let secHasVisibleElements = false;

            sec.elements.forEach(elem => {
                /*
                 * Element conditional logic.
                 */
                if (elem.parentId) {
                    const rawParentVal =
                        this.answers[
                            elem.parentId
                        ];

                    const parentVal =
                        rawParentVal
                            ? String(rawParentVal)
                                  .trim()
                                  .toLowerCase()
                            : '';

                    const normalizedShowWhen =
                        (elem.showWhen || [])
                            .map(v =>
                                String(v)
                                    .trim()
                                    .toLowerCase()
                            );

                    elem.isVisible =
                        Boolean(parentVal) &&
                        normalizedShowWhen.includes(
                            parentVal
                        );

                    if (!elem.isVisible) {
                        delete this.answers[elem.id];
                        elem.value = '';
                    }
                } else {
                    elem.isVisible = true;
                }

                /*
                 * Restore current answer into the element.
                 */
                if (
                    this.answers[elem.id] !==
                    undefined
                ) {
                    elem.value =
                        this.answers[elem.id];
                }

                if (!elem.isVisible) {
                    return;
                }

                secHasVisibleElements = true;

                /*
                 * IMPORTANT:
                 * This is the original working dead-end
                 * configuration rule.
                 *
                 * Apex marks ONLY an Info branch as terminal
                 * when exactly one configured outcome exists
                 * for that parent + response combination.
                 */
                if (elem.terminal === true) {
                    pageHasDeadEnd = true;
                }
            });

            if (!secHasVisibleElements) {
                sec.isVisible = false;
            } else {
                pageHasVisibleSections = true;
            }
        });

        page.isVisible =
            pageHasVisibleSections;

        if (pageHasDeadEnd) {
            page.isDeadEnd = true;
            isDeadEndReached = true;
        }
    });

    /*
     * Recalculate navigation after the dead-end cutoff.
     */
    const visiblePages =
        this.pages.filter(
            page => page.isVisible
        );

    visiblePages.forEach(
        (page, index) => {
            page.hasPrevPage =
                index > 0;

            page.hasNextPage =
                !page.isDeadEnd &&
                index < visiblePages.length - 1;
        }
    );

    /*
     * Keep active page reachable.
     */
    if (
        this.activePageId &&
        !visiblePages.some(
            page =>
                page.id ===
                this.activePageId
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

    isNodeConditionVisible(node, visited = new Set()) {
        if (!node) {
            return false;
        }

        if (!node.parentId) {
            return true;
        }

        if (visited.has(node.id)) {
            return false;
        }

        visited.add(node.id);

        const parent =
            this.nodeById.get(node.parentId);

        if (
            !parent ||
            !this.isNodeConditionVisible(parent, visited)
        ) {
            return false;
        }

        return this.checkVisibility(
            node.parentId,
            node.showWhen
        );
    }

    isRuntimeDeadEnd(element) {
        if (
            !element ||
            !element.isVisible ||
            !element.parentId ||
            !element.isInfo
        ) {
            return false;
        }

        /*
         * The parent must actually have a meaningful answer.
         * This prevents an unselected conditional Info from being
         * interpreted as a dead end.
         */
        const parentAnswer =
            this.getNormalizedAnswer(element.parentId);

        if (parentAnswer === '') {
            return false;
        }

        const children =
            this.childrenByParentId.get(element.parentId) || [];

        const visibleChildren =
            children.filter(child => child.isVisible);

        return (
            visibleChildren.length === 1 &&
            visibleChildren[0].id === element.id
        );
    }

    findNode(nodeId) {
        return this.nodeById.get(nodeId) || null;
    }

    isElementVisible(elementId) {
        const node = this.findNode(elementId);
        return node ? node.isVisible : false;
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
                element.isCheckbox ? false : '';
        });
    }

    validateCurrentPage() {
        const inputs = [
            ...this.template.querySelectorAll(
                'lightning-input, lightning-textarea, lightning-combobox'
            )
        ];

        return inputs.every(input => {
            const valid = input.checkValidity();

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
            this.pages.filter(page => page.isVisible);

        const currentIndex =
            visiblePages.findIndex(
                page => page.id === this.activePageId
            );

        if (
            currentIndex >= 0 &&
            currentIndex < visiblePages.length - 1
        ) {
            this.activePageId =
                visiblePages[currentIndex + 1].id;

            this.updatePageVisibility();
            this.scrollToTop();
        }
    }

    handlePrevious() {
        const visiblePages =
            this.pages.filter(page => page.isVisible);

        const currentIndex =
            visiblePages.findIndex(
                page => page.id === this.activePageId
            );

        if (currentIndex > 0) {
            this.activePageId =
                visiblePages[currentIndex - 1].id;

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
            programName: this.programName,
            formTitle:
                this.programName || 'Untitled Form',
            submissionToken:
                this.submissionToken,
            formResponsesJson:
                JSON.stringify(submissionData)
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
                        title: 'Submission failed',
                        message: this.errorMessage,
                        variant: 'error'
                    })
                );
            });
    }

    generateSubmissionToken() {
        if (
            typeof crypto !== 'undefined' &&
            typeof crypto.randomUUID === 'function'
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
            this.template.querySelector('.form-canvas');

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