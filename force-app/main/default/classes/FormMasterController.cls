public without sharing class FormMasterController {
    private static final Integer MAX_PAYLOAD_LENGTH = 100000;
    private static final Integer MAX_FORM_TITLE_LENGTH = 255;
    private static final Integer MAX_SUBMISSION_TOKEN_LENGTH = 80;

    @AuraEnabled(cacheable=true)
    public static List<FormElement> getFormDefinition(String programName) {
        if (String.isBlank(programName)) {
            throw new AuraHandledException('A program name is required.');
        }

        List<Form_Master_Data__c> records = [
            SELECT
                Id,
                Name,
                Question__c,
                FM_Data_Type__c,
                Secondary_Text_Rich__c,
                Picklist_Values__c,
                Section__c,
                Section_Layout__c,
                Order__c,
                Is_Question_Mandatory__c,
                RecordType.DeveloperName,
                Parent_Question__c,
                Response_for_Additional_Question__c,
                Page__c,
                Page__r.Name,
                Page__r.Page_Name__c,
                Page__r.Question__c,
                Page__r.Order__c,
                Section__r.Page__c,
                Section__r.Page__r.Name,
                Section__r.Page__r.Page_Name__c,
                Section__r.Page__r.Question__c,
                Section__r.Page__r.Order__c
            FROM Form_Master_Data__c
            WHERE Program__r.Program_Name__c = :programName
              AND RecordType.DeveloperName IN ('Form_Question', 'Section')
            WITH USER_MODE
            ORDER BY Page__r.Order__c NULLS FIRST, Order__c NULLS LAST, Name
        ];

        List<FormElement> elements = new List<FormElement>();

        for (Form_Master_Data__c record : records) {
            elements.add(new FormElement(record));
        }

        flagDeadEnds(elements);
        return elements;
    }

    @AuraEnabled
    public static Id submitFormResponses(
        String programName,
        String formTitle,
        String submissionToken,
        String formResponsesJson
    ) {
        try {
            validateSubmissionRequest(
                programName,
                submissionToken,
                formResponsesJson
            );

            validateSubmissionAccess();

            Map<String, Object> responseMap =
                parseResponsePayload(formResponsesJson);

            Map<Id, Form_Master_Data__c> metadataById =
                loadProgramMetadata(programName);

            validateQuestionIds(responseMap, metadataById);

            Decimal deadEndPageOrder =
                findDeadEndPageOrder(responseMap, metadataById);

            validateReachableResponses(
                responseMap,
                metadataById,
                deadEndPageOrder
            );

            validateRequiredQuestions(
                responseMap,
                metadataById,
                deadEndPageOrder
            );

            preventDuplicateSubmission(submissionToken);

            Form_Submission__c submission = new Form_Submission__c(
                Form_Title__c = normalizeFormTitle(formTitle),
                Status__c = 'Submitted',
                Submitted_Date__c = System.now(),
                Submission_Token__c = submissionToken
            );

            Database.insert(
                submission,
                AccessLevel.SYSTEM_MODE
            );

            List<Form_Answer__c> answers = new List<Form_Answer__c>();

            for (String questionKey : responseMap.keySet()) {
                Id questionId = (Id)questionKey;
                Form_Master_Data__c question =
                    metadataById.get(questionId);

                answers.add(
                    new Form_Answer__c(
                        Submission__c = submission.Id,
                        Question_Identifier__c = String.valueOf(question.Id),
                        Question_Text__c = question.Question__c,
                        Response_Value__c =
                            convertResponseToString(
                                responseMap.get(questionKey)
                            )
                    )
                );
            }

            if (!answers.isEmpty()) {
                Database.insert(
                    answers,
                    AccessLevel.SYSTEM_MODE
                );
            }

            return submission.Id;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException(
                'Unable to submit the form. Please try again.'
            );
        }
    }

    private static void validateSubmissionRequest(
        String programName,
        String submissionToken,
        String formResponsesJson
    ) {
        if (String.isBlank(programName)) {
            throw new AuraHandledException('A program name is required.');
        }

        if (
            String.isBlank(submissionToken) ||
            submissionToken.length() > MAX_SUBMISSION_TOKEN_LENGTH
        ) {
            throw new AuraHandledException('Invalid submission.');
        }

        if (String.isBlank(formResponsesJson)) {
            throw new AuraHandledException(
                'No form responses were provided.'
            );
        }

        if (formResponsesJson.length() > MAX_PAYLOAD_LENGTH) {
            throw new AuraHandledException(
                'The submission is too large.'
            );
        }
    }

    private static void validateSubmissionAccess() {
        if (
            !Schema.sObjectType.Form_Submission__c.isCreateable() ||
            !Schema.sObjectType.Form_Answer__c.isCreateable()
        ) {
            throw new AuraHandledException(
                'Form submission is not available.'
            );
        }

        if (
            !Schema.sObjectType.Form_Submission__c
                .fields.Form_Title__c.isCreateable() ||
            !Schema.sObjectType.Form_Submission__c
                .fields.Status__c.isCreateable() ||
            !Schema.sObjectType.Form_Submission__c
                .fields.Submitted_Date__c.isCreateable() ||
            !Schema.sObjectType.Form_Submission__c
                .fields.Submission_Token__c.isCreateable() ||
            !Schema.sObjectType.Form_Answer__c
                .fields.Submission__c.isCreateable() ||
            !Schema.sObjectType.Form_Answer__c
                .fields.Question_Identifier__c.isCreateable() ||
            !Schema.sObjectType.Form_Answer__c
                .fields.Question_Text__c.isCreateable() ||
            !Schema.sObjectType.Form_Answer__c
                .fields.Response_Value__c.isCreateable()
        ) {
            throw new AuraHandledException(
                'Form submission is not configured correctly.'
            );
        }
    }

    private static Map<String, Object> parseResponsePayload(String json) {
        try {
            Object parsed = System.JSON.deserializeUntyped(json);

            if (!(parsed instanceof Map<String, Object>)) {
                throw new AuraHandledException(
                    'Invalid submission format.'
                );
            }

            Map<String, Object> rawPayload =
                (Map<String, Object>)parsed;

            if (rawPayload.isEmpty()) {
                throw new AuraHandledException(
                    'No form responses were provided.'
                );
            }

            Map<String, Object> responseMap =
                new Map<String, Object>();

            for (String key : rawPayload.keySet()) {
                Object rawValue = rawPayload.get(key);

                if (rawValue instanceof Map<String, Object>) {
                    Map<String, Object> wrapper =
                        (Map<String, Object>)rawValue;

                    responseMap.put(key, wrapper.get('value'));
                } else {
                    responseMap.put(key, rawValue);
                }
            }

            return responseMap;
        } catch (AuraHandledException e) {
            throw e;
        } catch (Exception e) {
            throw new AuraHandledException(
                'Invalid submission format.'
            );
        }
    }

    private static Map<Id, Form_Master_Data__c> loadProgramMetadata(
        String programName
    ) {
        Map<Id, Form_Master_Data__c> metadataById =
            new Map<Id, Form_Master_Data__c>();

        for (Form_Master_Data__c record : [
            SELECT
                Id,
                Name,
                Question__c,
                FM_Data_Type__c,
                Secondary_Text_Rich__c,
                Picklist_Values__c,
                Section__c,
                Section_Layout__c,
                Order__c,
                Is_Question_Mandatory__c,
                RecordType.DeveloperName,
                Parent_Question__c,
                Response_for_Additional_Question__c,
                Page__c,
                Page__r.Name,
                Page__r.Page_Name__c,
                Page__r.Question__c,
                Page__r.Order__c,
                Section__r.Page__c,
                Section__r.Page__r.Name,
                Section__r.Page__r.Page_Name__c,
                Section__r.Page__r.Question__c,
                Section__r.Page__r.Order__c
            FROM Form_Master_Data__c
            WHERE Program__r.Program_Name__c = :programName
              AND RecordType.DeveloperName IN ('Form_Question', 'Section')
            WITH SYSTEM_MODE
            ORDER BY Page__r.Order__c NULLS FIRST, Order__c NULLS LAST, Name
        ]) {
            metadataById.put(record.Id, record);
        }

        return metadataById;
    }

    private static void validateQuestionIds(
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById
    ) {
        for (String key : responseMap.keySet()) {
            if (
                !isValidSalesforceId(key) ||
                !metadataById.containsKey((Id)key) ||
                metadataById.get((Id)key).RecordType.DeveloperName !=
                    'Form_Question'
            ) {
                throw new AuraHandledException(
                    'The submission contains a question that does not belong to this form.'
                );
            }

            if (
                !isRenderableQuestion(
                    metadataById.get((Id)key),
                    metadataById
                )
            ) {
                throw new AuraHandledException(
                    'The submission contains a question that is not part of the rendered form.'
                );
            }
        }
    }

    private static Boolean isRenderableQuestion(
        Form_Master_Data__c question,
        Map<Id, Form_Master_Data__c> metadataById
    ) {
        if (
            question == null ||
            question.RecordType.DeveloperName != 'Form_Question' ||
            question.Section__c == null
        ) {
            return false;
        }

        Form_Master_Data__c section =
            metadataById.get(question.Section__c);

        return section != null &&
            section.RecordType.DeveloperName == 'Section';
    }

    private static void flagDeadEnds(
        List<FormElement> elements
    ) {
        Map<String, List<FormElement>> byBranch =
            new Map<String, List<FormElement>>();

        for (FormElement element : elements) {
            element.terminal = false;

            if (
                String.isBlank(element.parentId) ||
                element.dataType == 'Section'
            ) {
                continue;
            }

            String key =
                element.parentId +
                '|' +
                String.join(
                    element.showWhen == null
                        ? new List<String>()
                        : element.showWhen,
                    ','
                );

            if (!byBranch.containsKey(key)) {
                byBranch.put(
                    key,
                    new List<FormElement>()
                );
            }

            byBranch.get(key).add(element);
        }

        for (List<FormElement> branch : byBranch.values()) {
            if (
                branch.size() == 1 &&
                branch[0].dataType == 'Info'
            ) {
                branch[0].terminal = true;
            }
        }
    }

    private static Decimal findDeadEndPageOrder(
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById
    ) {
        List<FormElement> elements =
            new List<FormElement>();

        for (Form_Master_Data__c record : metadataById.values()) {
            elements.add(new FormElement(record));
        }

        flagDeadEnds(elements);

        Decimal firstDeadEndPageOrder;

        for (FormElement element : elements) {
            if (element.terminal != true) {
                continue;
            }

            Form_Master_Data__c record =
                metadataById.get((Id)element.id);

            if (
                record == null ||
                !isRenderableQuestion(record, metadataById)
            ) {
                continue;
            }

            if (
                !isRecordVisible(
                    record,
                    responseMap,
                    metadataById,
                    new Set<Id>()
                )
            ) {
                continue;
            }

            Decimal pageOrder =
                getPageOrder(record, metadataById);

            if (
                firstDeadEndPageOrder == null ||
                pageOrder < firstDeadEndPageOrder
            ) {
                firstDeadEndPageOrder = pageOrder;
            }
        }

        return firstDeadEndPageOrder;
    }

    private static void validateReachableResponses(
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById,
        Decimal deadEndPageOrder
    ) {
        for (String key : responseMap.keySet()) {
            Form_Master_Data__c question =
                metadataById.get((Id)key);

            if (question == null) {
                continue;
            }

            if (!isRenderableQuestion(question, metadataById)) {
                throw new AuraHandledException(
                    'The submission contains a question that is not part of the rendered form.'
                );
            }

            Decimal questionPageOrder =
                getPageOrder(question, metadataById);

            if (
                deadEndPageOrder != null &&
                questionPageOrder > deadEndPageOrder
            ) {
                throw new AuraHandledException(
                    'The submission contains a response from an unreachable section of the form.'
                );
            }

            if (
                !isRecordVisible(
                    question,
                    responseMap,
                    metadataById,
                    new Set<Id>()
                )
            ) {
                throw new AuraHandledException(
                    'The submission contains a response for a question that is not applicable.'
                );
            }

            validateResponseValue(
                question,
                responseMap.get(key)
            );
        }
    }

    private static void validateRequiredQuestions(
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById,
        Decimal deadEndPageOrder
    ) {
        for (Form_Master_Data__c question : metadataById.values()) {
            if (!isRenderableQuestion(question, metadataById)) {
                continue;
            }

            if (
                question.Is_Question_Mandatory__c != true ||
                question.FM_Data_Type__c == 'Info'
            ) {
                continue;
            }

            Decimal questionPageOrder =
                getPageOrder(question, metadataById);

            if (
                deadEndPageOrder != null &&
                questionPageOrder > deadEndPageOrder
            ) {
                continue;
            }

            if (
                !isRecordVisible(
                    question,
                    responseMap,
                    metadataById,
                    new Set<Id>()
                )
            ) {
                continue;
            }

            Object answerValue =
                responseMap.get(String.valueOf(question.Id));

            if (!hasMeaningfulValue(question, answerValue)) {
                String questionLabel =
                    String.isNotBlank(question.Question__c)
                        ? question.Question__c
                        : question.Name;

                throw new AuraHandledException(
                    'A required question was not answered: ' +
                    questionLabel
                );
            }
        }
    }

    private static Boolean isRecordVisible(
        Form_Master_Data__c record,
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById,
        Set<Id> visited
    ) {
        if (record == null) {
            return false;
        }

        if (visited.contains(record.Id)) {
            throw new AuraHandledException(
                'Invalid form configuration: circular conditional logic.'
            );
        }

        Set<Id> currentVisited = new Set<Id>();
        currentVisited.addAll(visited);
        currentVisited.add(record.Id);

        if (record.Section__c != null) {
            Form_Master_Data__c section =
                metadataById.get(record.Section__c);

            if (
                section != null &&
                !isRecordConditionVisible(
                    section,
                    responseMap,
                    metadataById,
                    currentVisited
                )
            ) {
                return false;
            }
        }

        return isRecordConditionVisible(
            record,
            responseMap,
            metadataById,
            currentVisited
        );
    }

    private static Boolean isRecordConditionVisible(
        Form_Master_Data__c record,
        Map<String, Object> responseMap,
        Map<Id, Form_Master_Data__c> metadataById,
        Set<Id> visited
    ) {
        if (record.Parent_Question__c == null) {
            return true;
        }

        Form_Master_Data__c parent =
            metadataById.get(record.Parent_Question__c);

        if (parent == null) {
            return false;
        }

        if (visited.contains(parent.Id)) {
            throw new AuraHandledException(
                'Invalid form configuration: circular conditional logic.'
            );
        }

        Set<Id> parentVisited = new Set<Id>();
        parentVisited.addAll(visited);

        if (
            !isRecordVisible(
                parent,
                responseMap,
                metadataById,
                parentVisited
            )
        ) {
            return false;
        }

        Object parentValue =
            responseMap.get(String.valueOf(parent.Id));

        if (parentValue == null) {
            return false;
        }

        String normalizedParentValue =
            String.valueOf(parentValue)
                .trim()
                .toLowerCase();

        if (String.isBlank(normalizedParentValue)) {
            return false;
        }

        List<String> parentValues = new List<String>();

        for (String value : normalizedParentValue.split(';')) {
            if (String.isNotBlank(value)) {
                parentValues.add(value.trim());
            }
        }

        for (
            String expectedResponse :
            splitResponses(
                record.Response_for_Additional_Question__c
            )
        ) {
            if (parentValues.contains(expectedResponse)) {
                return true;
            }
        }

        return false;
    }

    private static void validateResponseValue(
        Form_Master_Data__c question,
        Object value
    ) {
        if (value == null) {
            return;
        }

        String dataType = question.FM_Data_Type__c;

        if (dataType == 'Checkbox') {
            if (
                !(value instanceof Boolean) &&
                !(value instanceof String)
            ) {
                throw new AuraHandledException(
                    'Invalid checkbox response.'
                );
            }
            return;
        }

        if (dataType == 'Date') {
            try {
                Date.valueOf(String.valueOf(value));
            } catch (Exception e) {
                throw new AuraHandledException(
                    'Invalid date response.'
                );
            }
            return;
        }

        if (dataType == 'Picklist') {
            validatePicklistValue(question, value);
            return;
        }

        if (
            dataType == 'Text' ||
            dataType == 'Text Area' ||
            dataType == 'Additional Q'
        ) {
            if (
                value instanceof Map<String, Object> ||
                value instanceof List<Object>
            ) {
                throw new AuraHandledException(
                    'Invalid text response.'
                );
            }
        }
    }

    private static void validatePicklistValue(
        Form_Master_Data__c question,
        Object rawValue
    ) {
        if (String.isBlank(question.Picklist_Values__c)) {
            throw new AuraHandledException(
                'A picklist is not configured correctly.'
            );
        }

        Set<String> validValues = new Set<String>();

        String text =
            question.Picklist_Values__c
                .replaceAll('\n', ';')
                .replaceAll('\r', '');

        for (String part : text.split(';')) {
            String trimmed = part.trim();

            if (String.isBlank(trimmed)) {
                continue;
            }

            List<String> pieces = trimmed.split('\\|');

            validValues.add(
                pieces.size() > 1
                    ? pieces[1].trim()
                    : pieces[0].trim()
            );
        }

        if (!validValues.contains(String.valueOf(rawValue))) {
            throw new AuraHandledException(
                'An invalid picklist value was submitted.'
            );
        }
    }

    private static Boolean hasMeaningfulValue(
        Form_Master_Data__c question,
        Object value
    ) {
        if (value == null) {
            return false;
        }

        if (value instanceof String) {
            return String.isNotBlank((String)value);
        }

        if (question.FM_Data_Type__c == 'Checkbox') {
            if (value instanceof Boolean) {
                return (Boolean)value;
            }

            if (value instanceof String) {
                return String.valueOf(value)
                    .trim()
                    .toLowerCase() == 'true';
            }

            return false;
        }

        return true;
    }

    private static Decimal getPageOrder(
        Form_Master_Data__c record,
        Map<Id, Form_Master_Data__c> metadataById
    ) {
        if (record == null) {
            return 0;
        }

        if (
            record.Page__r != null &&
            record.Page__r.Order__c != null
        ) {
            return record.Page__r.Order__c;
        }

        if (
            record.Section__c != null &&
            metadataById.containsKey(record.Section__c)
        ) {
            Form_Master_Data__c section =
                metadataById.get(record.Section__c);

            if (
                section.Page__r != null &&
                section.Page__r.Order__c != null
            ) {
                return section.Page__r.Order__c;
            }
        }

        return 0;
    }

    private static void preventDuplicateSubmission(
        String submissionToken
    ) {
        if (
            ![
                SELECT Id
                FROM Form_Submission__c
                WHERE Submission_Token__c = :submissionToken
                LIMIT 1
            ].isEmpty()
        ) {
            throw new AuraHandledException(
                'This submission has already been received.'
            );
        }
    }

    private static Boolean isValidSalesforceId(String value) {
        if (
            String.isBlank(value) ||
            (value.length() != 15 && value.length() != 18)
        ) {
            return false;
        }

        try {
            Id convertedId = (Id)value;
            return convertedId != null;
        } catch (Exception e) {
            return false;
        }
    }

    private static String convertResponseToString(Object value) {
        if (value == null) {
            return null;
        }

        if (
            value instanceof List<Object> ||
            value instanceof Map<String, Object>
        ) {
            return JSON.serialize(value);
        }

        return String.valueOf(value);
    }

    private static String normalizeFormTitle(String title) {
        if (String.isBlank(title)) {
            return 'Untitled Form';
        }

        title = title.trim();

        return title.length() <= MAX_FORM_TITLE_LENGTH
            ? title
            : title.substring(0, MAX_FORM_TITLE_LENGTH);
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
            id = String.valueOf(record.Id);
            name = record.Name;

            dataType =
                record.RecordType.DeveloperName == 'Section'
                    ? 'Section'
                    : record.FM_Data_Type__c;

            sectionId = record.Section__c;
            layout = record.Section_Layout__c;
            sortOrder = record.Order__c;
            pageId = record.Page__c;
            parentId = record.Parent_Question__c;

            if (record.Page__c != null) {
                if (String.isNotBlank(record.Page__r.Page_Name__c)) {
                    pageName = record.Page__r.Page_Name__c;
                } else if (String.isNotBlank(record.Page__r.Question__c)) {
                    pageName = record.Page__r.Question__c;
                } else {
                    pageName = record.Page__r.Name;
                }

                pageOrder = record.Page__r.Order__c;
            } else if (
                record.Section__r != null &&
                record.Section__r.Page__r != null
            ) {
                if (
                    String.isNotBlank(
                        record.Section__r.Page__r.Page_Name__c
                    )
                ) {
                    pageName =
                        record.Section__r.Page__r.Page_Name__c;
                } else if (
                    String.isNotBlank(
                        record.Section__r.Page__r.Question__c
                    )
                ) {
                    pageName =
                        record.Section__r.Page__r.Question__c;
                } else {
                    pageName =
                        record.Section__r.Page__r.Name;
                }

                pageOrder =
                    record.Section__r.Page__r.Order__c;
            }

            showWhen =
                splitResponses(
                    record.Response_for_Additional_Question__c
                );

            required =
                record.Is_Question_Mandatory__c == true;

            terminal = false;

            label =
                record.Question__c == null
                    ? ''
                    : record.Question__c.trim();

            richText = record.Secondary_Text_Rich__c;

            choices =
                record.FM_Data_Type__c == 'Picklist'
                    ? parseChoices(record.Picklist_Values__c)
                    : new List<Choice>();
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

    private static List<Choice> parseChoices(String rawChoices) {
        List<Choice> choices = new List<Choice>();

        if (String.isBlank(rawChoices)) {
            return choices;
        }

        String text =
            rawChoices
                .replaceAll('\n', ';')
                .replaceAll('\r', '');

        for (String part : text.split(';')) {
            String trimmed = part.trim();

            if (String.isBlank(trimmed)) {
                continue;
            }

            List<String> labelValue =
                trimmed.split('\\|');

            String label =
                labelValue[0].trim();

            String value =
                labelValue.size() > 1
                    ? labelValue[1].trim()
                    : label;

            if (String.isNotBlank(label)) {
                choices.add(
                    new Choice(label, value)
                );
            }
        }

        return choices;
    }
}