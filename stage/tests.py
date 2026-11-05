import json
from django.test import TestCase, Client
from django.urls import reverse
from .models import SongProject, Section, Measure

class SyncStageTests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_root_studio_view_clean_state(self):
        resp = self.client.get(reverse('studio'))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'initial-project-data')
        self.assertContains(resp, 'UNTITLED PROJECT')

    def test_save_and_load_timing_points(self):
        save_payload = {
            "title": "ABBA WORSHIP",
            "key": "E",
            "bpm": 135.0,
            "totalMeasures": 32,
            "beatsPerBar": 4,
            "timingPoints": [
                {"id": 1, "offset": 0.852, "bpm": 135.0, "beatsPerBar": 4},
                {"id": 2, "offset": 45.120, "bpm": 135.0, "beatsPerBar": 4}
            ],
            "sections": [
                {"startBar": 1, "name": "Intro", "color": "#facc15", "isNewSong": True, "songTitle": "ABBA WORSHIP", "songKey": "E"}
            ],
            "measures": [
                {"bar": 1, "chordLine": "E . B .", "leadLine": ""}
            ]
        }

        # 1. Save new project via API
        save_resp = self.client.post(
            reverse('api_save_new'),
            data=json.dumps(save_payload),
            content_type='application/json'
        )
        self.assertEqual(save_resp.status_code, 200)
        project_id = save_resp.json()['projectId']

        # 2. Check timing points in DB
        project = SongProject.objects.get(id=project_id)
        self.assertEqual(len(project.timing_points), 2)
        self.assertEqual(project.timing_points[0]['offset'], 0.852)

        # 3. Check studio_view returns exact timing points (prevents desync on refresh)
        view_resp = self.client.get(reverse('studio_project', kwargs={'project_id': project_id}))
        self.assertEqual(view_resp.status_code, 200)
        self.assertContains(view_resp, '0.852')

        # 4. Check load_project_api returns timing points
        api_load_resp = self.client.get(reverse('api_load_project', kwargs={'project_id': project_id}))
        self.assertEqual(api_load_resp.status_code, 200)
        loaded_data = api_load_resp.json()
        self.assertEqual(len(loaded_data['project']['timingPoints']), 2)
        self.assertEqual(loaded_data['project']['timingPoints'][0]['offset'], 0.852)

    def test_delete_project(self):
        project = SongProject.objects.create(title="Delete Me", bpm=120)
        del_resp = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertEqual(del_resp.json()['status'], 'deleted')
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())
