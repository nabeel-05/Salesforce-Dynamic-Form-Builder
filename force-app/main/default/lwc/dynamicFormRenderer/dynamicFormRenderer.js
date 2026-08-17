import { LightningElement, api, track } from 'lwc';
import getFormDefinition from '@salesforce/apex/FormMasterController.getFormDefinition';

export default class DynamicFormRenderer extends LightningElement {
    @api programName = 'AYEI Test Program';

    @track pages = [];
    answers = {};
    isLoading = true;
    errorMessage;
    activePageId;

    connectedCallback() {
        this.fetchFormDefinition();
    }

    fetchFormDefinition() {
        getFormDefinition({ programName: this.programName })
            .then(data => {
                this.buildHierarchy(data);
                this.evaluateLogic();
                if (this.pages.length > 0) {
                    this.activePageId = this.pages[0].id;
                    this.updatePageAccordionClasses();
                }
                this.isLoading = false;
            })
            .catch(error => {
                this.errorMessage = error.body ? error.body.message : error.message;
                this.isLoading = false;
            });
    }

    buildHierarchy(elements) {
        const pageMap = new Map();
        const sectionMap = new Map();

        // ==========================================
        // 1. Structure Pages and Sections
        // ==========================================
        elements.forEach(el => {
            if (el.dataType === 'Section') {
                if (!pageMap.has(el.pageId)) {
                    pageMap.set(el.pageId, {
                        id: el.pageId,
                        name: el.pageName || 'Untitled Page',
                        order: el.pageOrder || 0,
                        sections: [],
                        isDeadEnd: false,
                        isOpen: false,
                        isLocked: true,
                        isComplete: false,
                        sectionClass: 'slds-section slds-is-open slds-m-bottom_small'
                    });
                }

                let layoutClass = 'slds-col slds-size_1-of-1 slds-p-horizontal_small';
                if (el.layout === '2 Columns') {
                    layoutClass = 'slds-col slds-size_1-of-1 slds-medium-size_1-of-2 slds-p-horizontal_small';
                }

                const sec = {
                    ...el,
                    elements: [],
                    isVisible: !el.parentId,
                    layoutClass: layoutClass
                };
                sectionMap.set(el.id, sec);
                pageMap.get(el.pageId).sections.push(sec);
            }
        });

        // ==========================================
        // 2. Map Questions & Grab Apex Choices
        // ==========================================
        elements.forEach(el => {
            if (el.dataType !== 'Section' && el.sectionId && sectionMap.has(el.sectionId)) {
                let sec = sectionMap.get(el.sectionId);

                // YOUR APEX ALREADY DID THE WORK! Just grab the choices list.
                let parsedChoices = [];
                if (el.choices && Array.isArray(el.choices) && el.choices.length > 0) {
                    parsedChoices = el.choices;
                    console.log(`[Form Debug] Options for "${el.label}":`, JSON.parse(JSON.stringify(parsedChoices)));
                } else if (el.dataType === 'Picklist') {
                    console.warn(`[Form Debug] "${el.label}" is a Picklist but Apex sent no choices! Check your Form_Master_Data__c record.`);
                }

                // Check if it's a picklist data type (case insensitive)
                const isPicklist = el.dataType && el.dataType.toLowerCase() === 'picklist';

                sec.elements.push({
                    ...el,
                    isVisible: !el.parentId,
                    value: '',

                    options: parsedChoices,  // Map the Apex Choices directly to standard 'options'

                    helpText: el.richText || '',
                    required: el.required || false,

                    isInfo: el.dataType === 'Info',
                    isText: el.dataType === 'Text' || el.dataType === 'Additional Q',
                    isTextArea: el.dataType === 'Text Area',
                    isPicklist: isPicklist,
                    isDate: el.dataType === 'Date',
                    isCheckbox: el.dataType === 'Checkbox',
                    isFileUpload: el.dataType === 'File Upload'
                });
            }
        });

        // ==========================================
        // 3. Deep Sort Hierarchy based on Order__c
        // ==========================================
        Array.from(pageMap.values()).forEach(page => {
            page.sections.sort((a, b) => (a.order || 0) - (b.order || 0));
            page.sections.forEach(sec => {
                sec.elements.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
            });
        });

        this.pages = Array.from(pageMap.values())
            .sort((a, b) => (a.order || 0) - (b.order || 0))
            .map((p, idx, arr) => ({
                ...p,
                index: idx,
                isOpen: idx === 0,
                isLocked: idx !== 0,
                hasNextPage: idx < arr.length - 1
            }));
    }

    togglePageAccordion(event) {
        const pageId = event.currentTarget.dataset.id;
        this.activePageId = this.activePageId === pageId ? null : pageId;
        this.updatePageAccordionClasses();
    }

    updatePageAccordionClasses() {
        this.pages.forEach(p => {
            const isOpen = p.id === this.activePageId;
            p.isOpen = isOpen;
            p.sectionClass = isOpen ? 'slds-section slds-is-open slds-m-bottom_small' : 'slds-section slds-m-bottom_small';
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
        this.answers[fieldId] = event.target.checked ? 'true' : 'false';
        this.evaluateLogic();
    }

    evaluateLogic() {
        let isDeadEndReached = false;

        this.pages.forEach(page => {
            page.isDeadEnd = false;

            if (isDeadEndReached) {
                page.isVisible = false;
                return;
            }

            let pageHasVisibleSections = false;

            page.sections.forEach(sec => {
                if (sec.parentId) {
                    const rawParentVal = this.answers[sec.parentId];
                    const parentVal = rawParentVal ? String(rawParentVal).trim().toLowerCase() : '';
                    const normalizedShowWhen = (sec.showWhen || []).map(v => String(v).trim().toLowerCase());
                    sec.isVisible = Boolean(parentVal) && normalizedShowWhen.includes(parentVal);
                    if (!sec.isVisible) this.clearSectionAnswers(sec);
                } else {
                    sec.isVisible = true;
                }

                if (sec.isVisible) {
                    let secHasVisibleElements = false;

                    sec.elements.forEach(elem => {
                        if (elem.parentId) {
                            const rawParentVal = this.answers[elem.parentId];
                            const parentVal = rawParentVal ? String(rawParentVal).trim().toLowerCase() : '';
                            const normalizedShowWhen = (elem.showWhen || []).map(v => String(v).trim().toLowerCase());

                            elem.isVisible = Boolean(parentVal) && normalizedShowWhen.includes(parentVal);

                            if (!elem.isVisible) {
                                delete this.answers[elem.id];
                                elem.value = '';
                            }
                        } else {
                            elem.isVisible = true;
                        }

                        if (this.answers[elem.id]) {
                            elem.value = this.answers[elem.id];
                        }

                        if (elem.isVisible) {
                            secHasVisibleElements = true;
                            if (elem.terminal) {
                                isDeadEndReached = true;
                                page.isDeadEnd = true;
                            }
                        }
                    });

                    if (!secHasVisibleElements) {
                        sec.isVisible = false;
                    } else {
                        pageHasVisibleSections = true;
                    }
                }
            });

            page.isVisible = pageHasVisibleSections;
        });

        this.pages = [...this.pages];
    }

    clearSectionAnswers(section) {
        section.elements.forEach(el => {
            delete this.answers[el.id];
            el.value = '';
        });
    }

    handleNext(event) {
        const currentIndex = parseInt(event.target.dataset.index, 10);
        const inputs = [...this.template.querySelectorAll('lightning-input, lightning-textarea, lightning-combobox')];

        const allValid = inputs.reduce((validSoFar, inputCmp) => {
            inputCmp.reportValidity();
            return validSoFar && inputCmp.checkValidity();
        }, true);

        if (allValid && currentIndex < this.pages.length - 1) {
            this.activePageId = this.pages[currentIndex + 1].id;
            this.updatePageAccordionClasses();
        }
    }

    handleSubmit() {
        const inputs = [...this.template.querySelectorAll('lightning-input, lightning-textarea, lightning-combobox')];
        const allValid = inputs.reduce((validSoFar, inputCmp) => {
            inputCmp.reportValidity();
            return validSoFar && inputCmp.checkValidity();
        }, true);

        if (allValid) {
            alert('Form logic evaluated and validated! Ready for submission handler.');
        } else {
            alert('Please complete all required fields on the page.');
        }
    }
}