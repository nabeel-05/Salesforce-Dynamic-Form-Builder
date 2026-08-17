/**
 * Serves a configurable form definition out of Form_Master_Data__c.
 */
public without sharing class FormMasterController {

    @AuraEnabled(cacheable=true)
    public static List<FormElement> getFormDefinition(String programName) {
        if (String.isBlank(programName)) {
            throw new AuraHandledException('A program name is required.');
        }

        List<Form_Master_Data__c> records = [
            SELECT Id, Name, Question__c, FM_Data_Type__c, Secondary_Text_Rich__c, Picklist_Values__c,
                   Section__c, Section_Layout__c, Order__c,
                   Is_Question_Mandatory__c, 
                   RecordType.DeveloperName,
                   Parent_Question__c, Response_for_Additional_Question__c,
                   Page__c, Page__r.Name, Page__r.Page_Name__c, Page__r.Question__c, Page__r.Order__c
            FROM Form_Master_Data__c
            WHERE Program__r.Program_Name__c = :programName
              AND RecordType.DeveloperName IN ('Form_Question', 'Section')
            ORDER BY Page__r.Order__c NULLS FIRST, Order__c NULLS LAST, Name
        ];

        List<FormElement> elements = new List<FormElement>();
        for (Form_Master_Data__c record : records) {
            elements.add(new FormElement(record));
        }
        flagDeadEnds(elements);
        return elements;
    }

    private static void flagDeadEnds(List<FormElement> elements) {
        Map<String, List<FormElement>> byBranch = new Map<String, List<FormElement>>();
        for (FormElement element : elements) {
            if (String.isBlank(element.parentId)) {
                continue;
            }
            String key = element.parentId + '|' + String.join(element.showWhen, ',');
            if (!byBranch.containsKey(key)) {
                byBranch.put(key, new List<FormElement>());
            }
            byBranch.get(key).add(element);
        }

        for (List<FormElement> branch : byBranch.values()) {
            if (branch.size() == 1 && branch[0].dataType == 'Info') {
                branch[0].terminal = true;
            }
        }
    }

    public class FormElement {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public String label;
        @AuraEnabled public String dataType;
        @AuraEnabled public String richText;
        @AuraEnabled public String sectionId;
        @AuraEnabled public String layout;
        @AuraEnabled public Decimal sortOrder;
        @AuraEnabled public String pageId;
        @AuraEnabled public String pageName;
        @AuraEnabled public Decimal pageOrder;
        @AuraEnabled public String parentId;
        @AuraEnabled public List<String> showWhen;
        @AuraEnabled public Boolean required;
        @AuraEnabled public Boolean terminal;
        @AuraEnabled public List<Choice> choices;

        public FormElement(Form_Master_Data__c record) {
            this.id   = record.Id;
            this.name = record.Name;
            
            this.dataType = record.RecordType.DeveloperName == 'Section'
                ? 'Section'
                : record.FM_Data_Type__c;
            
            this.sectionId = record.Section__c;
            this.layout    = record.Section_Layout__c;
            this.sortOrder = record.Order__c;
            this.pageId    = record.Page__c;
            
            if (record.Page__c != null) {
                if (String.isNotBlank(record.Page__r.Page_Name__c)) {
                    this.pageName = record.Page__r.Page_Name__c;
                } else if (String.isNotBlank(record.Page__r.Question__c)) {
                    this.pageName = record.Page__r.Question__c;
                } else {
                    this.pageName = record.Page__r.Name;
                }
                this.pageOrder = record.Page__r.Order__c;
            }
            
            this.parentId  = record.Parent_Question__c;
            this.showWhen  = splitResponses(record.Response_for_Additional_Question__c);
            this.terminal  = false;

            this.label = record.Question__c == null ? '' : record.Question__c.trim();
            this.required = record.Is_Question_Mandatory__c == true;
            this.richText = record.Secondary_Text_Rich__c;

            if (record.FM_Data_Type__c == 'Picklist') {
                this.choices  = parseChoices(record.Picklist_Values__c);
            } else {
                this.choices  = new List<Choice>();
            }
        }
    }
    
    public class Choice {
        @AuraEnabled public String label;
        @AuraEnabled public String value;
        public Choice(String label, String value) {
            this.label = label;
            this.value = value;
        }
    }

    private static List<String> splitResponses(String raw) {
        List<String> responses = new List<String>();
        if (String.isBlank(raw)) {
            return responses;
        }
        for (String part : raw.split(';')) {
            if (String.isNotBlank(part)) {
                responses.add(part.trim().toLowerCase());
            }
        }
        return responses;
    }

    private static List<Choice> parseChoices(String rawChoices) {
        List<Choice> choices = new List<Choice>();
        if (String.isBlank(rawChoices)) {
            return choices;
        }

        // Newlines work as separators too, so we standardize on semicolons
        String text = rawChoices.replaceAll('\n', ';').replaceAll('\r', '');

        for (String part : text.split(';')) {
            String trimmed = part.trim();
            if (String.isBlank(trimmed)) {
                continue;
            }
            
            // Handle optional "Label|Value" syntax
            List<String> labelValue = trimmed.split('\\|');
            String label = labelValue[0].trim();
            String value = labelValue.size() > 1 ? labelValue[1].trim() : label;
            
            if (String.isNotBlank(label)) {
                choices.add(new Choice(label, value));
            }
        }
        return choices;
    }
}