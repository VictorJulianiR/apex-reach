public class DynamicQueries {
    private static final String CASE_FIELDS = 'Id, Subject';

    public static List<SObject> known(Id caseId) {
        return Database.query('SELECT Id, Subject FROM Case WHERE Id = :caseId');
    }

    public static List<SObject> knownThroughConstants(Id caseId) {
        String queryText = 'SELECT ' + CASE_FIELDS + ' FROM Case WHERE Id = :caseId';
        return Database.query(queryText);
    }

    public static List<SObject> unknown(String fields) {
        return Database.query('SELECT ' + fields + ' FROM Case');
    }
}
