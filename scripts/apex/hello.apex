
Id programId = 'a0ndN0000081Xq9QAE'; 

// 2. Call the method we just wrote
FormController.FormDTO formData = FormController.getFormDefinition(programId);

// 3. Convert our Apex object into beautiful JSON and print it
System.debug('\n\n=== MY FORM JSON ===\n' + JSON.serializePretty(formData));